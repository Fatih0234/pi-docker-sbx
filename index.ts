/**
 * pi-docker-sbx — Docker Sandboxes extension for pi.
 *
 * Delegates pi's core file, search, and shell tools to a Docker Sandbox.
 * Intentionally minimal: only session lifecycle and tool delegation.
 * For sandbox management (ports, status, diagnostics), use the `sbx` CLI.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { access, mkdir, readdir, readFile, writeFile as writeHostFile } from "node:fs/promises";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	FindOperations,
	ReadOperations,
	WriteOperations,
} from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";

interface SandboxCapabilities {
	hasBash: boolean;
	hasBase64: boolean;
	hasFile: boolean;
	hasRg: boolean;
	hasGrep: boolean;
	hasFind: boolean;
	hasCat: boolean;
	hasMkdir: boolean;
	hasLs: boolean;
	hasHead: boolean;
	workspaceExists: boolean;
	workspaceWritable: boolean;
	gitRepo: boolean;
}

interface SessionState {
	name: string;
	hostCwd: string;
	cwd: string;
	enabled: boolean;
	capabilities?: SandboxCapabilities;
	branch?: string;
	error?: string;
}

interface SbxConfig {
	defaultSandbox?: string;
	agent?: string;
	template?: string;
	branch?: string;
	cpus?: number;
	memory?: string;
	kits?: string[];
	extraWorkspaces?: string[];
	ports?: string[];
	env?: Record<string, string>;
}

interface CreateOptions {
	agent: string;
	template?: string;
	branch?: string;
	cpus?: number;
	memory?: string;
	kits: string[];
	extraWorkspaces: string[];
}

interface ExecResult {
	code: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

const PI_DOCKER_SBX_PREFIX = "pi-docker-sbx-";
const sessions = new Map<string, SessionState>();

function prefixedName(name: string): string {
	return name.startsWith(PI_DOCKER_SBX_PREFIX) ? name : PI_DOCKER_SBX_PREFIX + name;
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

function getState(ctx: ExtensionContext): SessionState | undefined {
	return sessions.get(ctx.sessionManager.getSessionId());
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

async function tryLocalRead(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

async function readConfig(path: string): Promise<Partial<SbxConfig>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Partial<SbxConfig>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		throw new Error(`Failed to load config from ${path}: ${messageOf(error)}`);
	}
}

async function loadConfig(cwd: string): Promise<SbxConfig> {
	const [globalCfg, localCfg] = await Promise.all([
		readConfig(join(homedir(), ".pi", "sbx.json")),
		readConfig(join(cwd, ".pi", "sbx.json")),
	]);
	return { ...globalCfg, ...localCfg };
}

function listFlag(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(listFlag);
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function run(command: string, args: string[], options: { input?: Buffer | string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		const kill = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignore kill errors.
				}
			}
		};

		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutHandle = setTimeout(kill, options.timeoutMs);
		}

		child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })));

		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
	});
}

async function sbx(args: string[], options: { input?: Buffer | string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExecResult> {
	const result = await run("sbx", args, options);
	if (result.code !== 0) {
		const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || `sbx ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result;
}

async function getSandbox(name: string): Promise<{ name: string; agent?: string; status?: string; workspaces?: string[] } | undefined> {
	const result = await sbx(["ls", "--json"]);
	try {
		const parsed = JSON.parse(result.stdout.toString("utf8")) as { sandboxes?: Array<{ name: string; agent?: string; status?: string; workspaces?: string[] }> };
		return parsed.sandboxes?.find((s) => s.name === name);
	} catch (error) {
		throw new Error(`Failed to parse sbx ls --json output: ${messageOf(error)}`);
	}
}

async function ensureSandbox(name: string, cwd: string, options: CreateOptions): Promise<{ workspace: string; existed: boolean }> {
	const existing = await getSandbox(name);
	if (existing) {
		await ensureSandboxRunning(name, existing.status);
		return { workspace: await resolveWorkspace(name, existing.workspaces?.[0] ?? cwd, options.branch), existed: true };
	}

	const args = ["create", "--name", name];
	if (options.branch) args.push("--branch", options.branch);
	if (options.template) args.push("--template", options.template);
	if (options.cpus !== undefined && Number.isFinite(options.cpus)) args.push("--cpus", String(options.cpus));
	if (options.memory) args.push("--memory", options.memory);
	for (const kit of options.kits) args.push("--kit", kit);
	args.push(options.agent, cwd, ...options.extraWorkspaces);
	await sbx(args, { timeoutMs: 120_000 });
	const created = await getSandbox(name);
	return { workspace: await resolveWorkspace(name, created?.workspaces?.[0] ?? cwd, options.branch), existed: false };
}

async function ensureSandboxRunning(name: string, status?: string): Promise<void> {
	if (status === "running") return;
	const result = await run("sbx", ["exec", name, "true"], { timeoutMs: 120_000 });
	if (result.code !== 0) {
		const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || `failed to start sandbox ${name}`;
		throw new Error(message);
	}
}

function parseCapabilityJson(text: string): SandboxCapabilities {
	const parsed = JSON.parse(text.trim()) as Partial<SandboxCapabilities>;
	return {
		hasBash: parsed.hasBash === true,
		hasBase64: parsed.hasBase64 === true,
		hasFile: parsed.hasFile === true,
		hasRg: parsed.hasRg === true,
		hasGrep: parsed.hasGrep === true,
		hasFind: parsed.hasFind === true,
		hasCat: parsed.hasCat === true,
		hasMkdir: parsed.hasMkdir === true,
		hasLs: parsed.hasLs === true,
		hasHead: parsed.hasHead === true,
		workspaceExists: parsed.workspaceExists === true,
		workspaceWritable: parsed.workspaceWritable === true,
		gitRepo: parsed.gitRepo === true,
	};
}

async function checkSandboxCapabilities(name: string, workspace: string): Promise<SandboxCapabilities> {
	const script = `
workspace=${shQuote(workspace)}
has() { command -v "$1" >/dev/null 2>&1; }
bool() { if "$@" >/dev/null 2>&1; then printf true; else printf false; fi; }
workspace_writable=false
if [ -d "$workspace" ] && [ -w "$workspace" ]; then
	tmp="$workspace/.pi-docker-sbx-preflight-$$"
	if : > "$tmp" 2>/dev/null; then
		rm -f "$tmp"
		workspace_writable=true
	fi
fi
printf '{'
printf '"hasBash":%s,' "$(bool has bash)"
printf '"hasBase64":%s,' "$(bool has base64)"
printf '"hasFile":%s,' "$(bool has file)"
printf '"hasRg":%s,' "$(bool has rg)"
printf '"hasGrep":%s,' "$(bool has grep)"
printf '"hasFind":%s,' "$(bool has find)"
printf '"hasCat":%s,' "$(bool has cat)"
printf '"hasMkdir":%s,' "$(bool has mkdir)"
printf '"hasLs":%s,' "$(bool has ls)"
printf '"hasHead":%s,' "$(bool has head)"
printf '"workspaceExists":%s,' "$(bool test -d "$workspace")"
printf '"workspaceWritable":%s,' "$workspace_writable"
printf '"gitRepo":%s' "$(bool git -C "$workspace" rev-parse --is-inside-work-tree)"
printf '}\\n'
`;
	const result = await run("sbx", ["exec", name, "sh", "-lc", script], { timeoutMs: 30_000 });
	if (result.code !== 0) {
		const reason = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "preflight command failed";
		throw new Error(`Sandbox preflight could not run in ${name}: ${reason}`);
	}
	try {
		return parseCapabilityJson(result.stdout.toString("utf8"));
	} catch (error) {
		throw new Error(`Sandbox preflight returned invalid JSON: ${messageOf(error)}. Output: ${result.stdout.toString("utf8").trim()}`);
	}
}

function criticalCapabilityError(workspace: string, capabilities: SandboxCapabilities): string | undefined {
	const missing: string[] = [];
	if (!capabilities.workspaceExists) missing.push(`workspace does not exist or is not mounted: ${workspace}`);
	if (!capabilities.workspaceWritable) missing.push(`workspace is not writable: ${workspace}`);
	if (!capabilities.hasBash) missing.push("bash is required for delegated shell/search tools");
	if (!capabilities.hasBase64) missing.push("base64 is required for delegated file reads");
	if (!capabilities.hasCat) missing.push("cat is required for delegated file writes");
	if (!capabilities.hasMkdir) missing.push("mkdir is required for delegated file writes");
	if (!capabilities.hasLs) missing.push("ls is required for delegated directory listing");
	if (!capabilities.hasHead) missing.push("head is required for output limiting");
	if (!capabilities.hasRg && !capabilities.hasGrep) missing.push("either rg or grep is required for delegated grep");
	if (missing.length === 0) return undefined;
	return ["Sandbox preflight failed. Missing required capabilities:", ...missing.map((item) => `  - ${item}`)].join("\n");
}

function capabilitySummary(capabilities: SandboxCapabilities): string {
	return [capabilities.hasRg ? "rg" : capabilities.hasGrep ? "grep" : "no-search", capabilities.hasFile ? "file" : "no-file", capabilities.hasFind ? "find" : "no-find", capabilities.gitRepo ? "git" : "no-git"].join(", ");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function existingPaths(paths: string[]): Promise<string[]> {
	const existing = await Promise.all(paths.map(async (path) => ((await pathExists(path)) ? path : undefined)));
	return [...new Set(existing.filter((path): path is string => path !== undefined))];
}

async function sandboxResourcePaths(state: SessionState): Promise<{ skillPaths: string[]; promptPaths: string[]; themePaths: string[] }> {
	return {
		skillPaths: await existingPaths([join(state.cwd, ".pi", "skills"), join(state.cwd, ".agents", "skills")]),
		promptPaths: await existingPaths([join(state.cwd, ".pi", "prompts")]),
		themePaths: await existingPaths([join(state.cwd, ".pi", "themes")]),
	};
}

async function gitRoot(cwd: string): Promise<string> {
	try {
		const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
		return result.code === 0 ? result.stdout.toString("utf8").trim() : cwd;
	} catch {
		return cwd;
	}
}

function dirsFromRoot(root: string, cwd: string): string[] {
	const dirs: string[] = [];
	let current = cwd;
	while (true) {
		dirs.unshift(current);
		if (current === root) return dirs;
		const parent = dirname(current);
		if (parent === current) return dirs;
		current = parent;
	}
}

async function sandboxContextFiles(state: SessionState): Promise<Array<{ path: string; content: string }>> {
	const root = await gitRoot(state.cwd);
	const candidates = dirsFromRoot(root, state.cwd).flatMap((dir) => [join(dir, "AGENTS.md"), join(dir, "CLAUDE.md")]);
	const files: Array<{ path: string; content: string }> = [];
	for (const path of [...new Set(candidates)]) {
		const content = await tryLocalRead(path);
		if (content) files.push({ path, content: content.toString("utf8") });
	}
	return files;
}

function sandboxEnvironmentBlock(state: SessionState, contextFiles: Array<{ path: string; content: string }>): string {
	const lines = [
		"",
		"## Docker Sandbox environment",
		"",
		"All delegated tools run inside an isolated Docker Sandbox microVM.",
		"",
		`- Sandbox: ${state.name}${state.branch ? ` (branch: ${state.branch})` : ""}`,
		`- Host Pi cwd: ${state.hostCwd}`,
		`- Sandbox tool cwd: ${state.cwd}`,
		...(state.capabilities ? [`- Sandbox capabilities: ${capabilitySummary(state.capabilities)}`] : []),
		"- Treat the sandbox tool cwd as authoritative for file, search, edit, and bash operations.",
		"- The workspace is mounted at its host path. File changes are reflected on the host immediately.",
		"- sudo is passwordless. Install system packages freely with apt-get.",
		"- Services must bind to 0.0.0.0 to be reachable from the host through published ports.",
		"- To reach services running on the user's host machine, use host.docker.internal instead of localhost.",
		"- Network access is governed by sandbox policy. If downloads or API calls fail unexpectedly, run `sbx policy log` to diagnose.",
	];

	if (contextFiles.length > 0) {
		lines.push("", "### Sandbox context files", "", "The following context files were loaded from the sandbox tool cwd and override conflicting host-cwd context:");
		for (const file of contextFiles) {
			lines.push("", `#### ${file.path}`, "", file.content);
		}
	}

	return lines.join("\n");
}

async function resolveWorkspace(name: string, workspace: string, branch?: string): Promise<string> {
	if (!branch) return workspace;

	const worktreeMarker = `/.sbx/${name}-worktrees/`;
	const markerIndex = workspace.indexOf(worktreeMarker);
	if (markerIndex !== -1) {
		const worktreeName = workspace.slice(markerIndex + worktreeMarker.length).split("/")[0];
		if ((branch === "auto" || worktreeName === branch) && (await pathExists(workspace))) return workspace;
		throw new Error(`Branch mode requested ${branch} for ${name}, but sbx reported unusable worktree ${workspace}.`);
	}

	const worktreesRoot = join(workspace, ".sbx", `${name}-worktrees`);
	const branchDir = branch === "auto" ? `sandbox-${name}` : branch;
	const expectedPath = join(worktreesRoot, branchDir);
	if (await pathExists(expectedPath)) return expectedPath;

	let candidates: string[] = [];
	try {
		const entries = await readdir(worktreesRoot, { withFileTypes: true });
		candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => join(worktreesRoot, entry.name));
	} catch (error) {
		throw new Error(`Branch mode requested for ${name}, but no worktree directory was found at ${worktreesRoot}: ${messageOf(error)}`);
	}

	if (branch === "auto" && candidates.length === 1) return candidates[0];

	throw new Error(
		`Branch mode requested for ${name}, but the expected worktree was not found at ${expectedPath}.${
			candidates.length > 0 ? ` Found: ${candidates.join(", ")}` : " No worktrees were found."
		}`,
	);
}

function toSandboxPath(state: SessionState, path: string): string {
	const clean = stripAt(path);
	if (clean === "" || clean === ".") return state.cwd;
	if (clean === state.cwd || clean.startsWith(state.cwd + "/")) return clean;
	if (clean === state.hostCwd) return state.cwd;
	if (clean.startsWith(state.hostCwd + "/")) return state.cwd + clean.slice(state.hostCwd.length);
	if (clean.startsWith("/")) return clean;
	return join(state.cwd, clean);
}


async function readSandboxFile(state: SessionState, absolutePath: string): Promise<Buffer> {
	const result = await sbx(["exec", state.name, "base64", "-w", "0", "--", toSandboxPath(state, absolutePath)], { timeoutMs: 120_000 });
	return Buffer.from(result.stdout.toString("utf8"), "base64");
}

async function writeSandboxFile(state: SessionState, absolutePath: string, content: Buffer | string): Promise<void> {
	const path = toSandboxPath(state, absolutePath);
	const script = `mkdir -p -- ${shQuote(dirname(path))} && cat > ${shQuote(path)}`;
	await sbx(["exec", "-i", state.name, "bash", "-lc", script], { input: content, timeoutMs: 120_000 });
}

function createSandboxReadOps(state: SessionState): ReadOperations {
	return {
		readFile: (absolutePath) => readSandboxFile(state, absolutePath),
		access: async (absolutePath) => {
			await sbx(["exec", state.name, "test", "-r", toSandboxPath(state, absolutePath)]);
		},
		detectImageMimeType: async (absolutePath) => {
			if (state.capabilities && !state.capabilities.hasFile) return null;
			try {
				const result = await sbx(["exec", state.name, "file", "--mime-type", "-b", toSandboxPath(state, absolutePath)]);
				const mime = result.stdout.toString("utf8").trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createSandboxWriteOps(state: SessionState): WriteOperations {
	return {
		writeFile: (absolutePath, content) => writeSandboxFile(state, absolutePath, content),
		mkdir: async (dir) => {
			await sbx(["exec", state.name, "mkdir", "-p", toSandboxPath(state, dir)]);
		},
	};
}

function createSandboxEditOps(state: SessionState): EditOperations {
	return {
		readFile: (absolutePath) => readSandboxFile(state, absolutePath),
		writeFile: (absolutePath, content) => writeSandboxFile(state, absolutePath, content),
		access: async (absolutePath) => {
			await sbx(["exec", state.name, "test", "-w", toSandboxPath(state, absolutePath)]);
		},
	};
}

function createSandboxFindOps(state: SessionState): FindOperations {
	return {
		exists: async (absolutePath) => {
			const result = await run("sbx", ["exec", state.name, "test", "-e", toSandboxPath(state, absolutePath)], { timeoutMs: 60_000 });
			return result.code === 0;
		},
		glob: async (pattern, cwd, options) => {
			const searchPath = toSandboxPath(state, cwd);
			const limit = Math.max(1, options.limit);
			const ignoreArgs = options.ignore.flatMap((glob) => ["--glob", `!${glob}`]);
			if (state.capabilities?.hasRg ?? true) {
				const args = ["rg", "--files", "--hidden", "--glob", pattern, ...ignoreArgs, "--", "."];
				const result = await run("sbx", ["exec", "-w", searchPath, state.name, ...args], { timeoutMs: 60_000 });
				if (result.code !== 0 && result.code !== 1) {
					const reason = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || `rg --files exited with code ${result.code}`;
					throw new Error(reason);
				}
				return result.stdout.toString("utf8").split("\n").filter(Boolean).slice(0, limit).map((line) => join(searchPath, line.replace(/^\.\//, "")));
			}

			if (!state.capabilities?.hasFind) throw new Error("Neither rg nor find is available in the sandbox");
			const script = `pattern=${shQuote(pattern)}; limit=${limit}; count=0; find . -type f ! -path '*/.git/*' ! -path '*/node_modules/*' -print | while IFS= read -r file; do rel=\${file#./}; base=\${rel##*/}; matched=false; case "$rel" in $pattern) matched=true;; esac; case "$base" in $pattern) matched=true;; esac; if [ "$matched" = true ]; then printf '%s/%s\\n' "$PWD" "$rel"; count=$((count + 1)); [ "$count" -ge "$limit" ] && break; fi; done`;
			const text = await sandboxText(state, script, searchPath);
			return text.split("\n").filter(Boolean);
		},
	};
}

function createSandboxBashOps(state: SessionState): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout }) {
			return new Promise((resolve, reject) => {
				const args = ["exec", "-w", cwd ? toSandboxPath(state, cwd) : state.cwd, state.name, "bash", "-lc", command];
				const child = spawn("sbx", args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
				let settled = false;
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				let stderrRemainder = "";

				const finish = (fn: () => void) => {
					if (settled) return;
					settled = true;
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const kill = () => {
					try {
						if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
						else child.kill("SIGKILL");
					} catch {
						try {
							child.kill("SIGKILL");
						} catch {
							// Ignore kill errors.
						}
					}
				};
				const onAbort = () => kill();

				const forwardStderr = (chunk: Buffer) => {
					stderrRemainder += chunk.toString("utf8");
					const lines = stderrRemainder.split("\n");
					stderrRemainder = lines.pop() ?? "";
					const visible = lines.filter((line) => !/^Sandbox .* started successfully$/.test(line) && line !== "INFO: Starting Docker daemon");
					if (visible.length > 0) onData(Buffer.from(visible.join("\n") + "\n", "utf8"));
				};

				child.stdout?.on("data", onData);
				child.stderr?.on("data", (chunk) => forwardStderr(Buffer.from(chunk)));
				child.on("error", (error) => finish(() => reject(error)));
				child.on("close", (code) =>
					finish(() => {
						if (stderrRemainder && !/^Sandbox .* started successfully$/.test(stderrRemainder) && stderrRemainder !== "INFO: Starting Docker daemon") {
							onData(Buffer.from(stderrRemainder + "\n", "utf8"));
						}
						if (signal?.aborted) reject(new Error("aborted"));
						else if (timedOut) reject(new Error(`timeout:${timeout}`));
						else resolve({ exitCode: code });
					}),
				);

				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						kill();
					}, timeout * 1000);
				}
			});
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toolText(text: string, emptyText: string, maxLines: number, details: Record<string, unknown> = {}) {
	const raw = text.trim() || emptyText;
	const truncation = truncateHead(raw, { maxLines });
	const suffix = truncation.truncated
		? `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
		: "";
	return {
		content: [{ type: "text" as const, text: truncation.content + suffix }],
		details: truncation.truncated ? { ...details, truncation } : Object.keys(details).length > 0 ? details : undefined,
	};
}

function activeSandbox(ctx: ExtensionContext | undefined): SessionState | undefined {
	if (!ctx) return undefined;
	const state = getState(ctx);
	if (!state) return undefined;
	if (state.error) throw new Error(state.error);
	return state.enabled ? state : undefined;
}

async function sandboxText(state: SessionState, script: string, cwd = state.cwd): Promise<string> {
	const result = await sbx(["exec", "-w", toSandboxPath(state, cwd), state.name, "bash", "-lc", script], { timeoutMs: 60_000 });
	return [result.stdout, result.stderr].filter((b) => b.length > 0).map((b) => b.toString("utf8")).join("");
}

interface BenchmarkResult {
	name: string;
	runs: number[];
	error?: string;
}

function nowMs(): number {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

function benchmarkStats(runs: number[]) {
	const sorted = [...runs].sort((a, b) => a - b);
	const sum = runs.reduce((total, run) => total + run, 0);
	return {
		min: sorted[0] ?? 0,
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		mean: runs.length === 0 ? 0 : sum / runs.length,
		max: sorted[sorted.length - 1] ?? 0,
	};
}

function formatMs(value: number): string {
	return value < 10 ? value.toFixed(1) : value.toFixed(0);
}

async function runBenchmarkCase(name: string, iterations: number, fn: () => Promise<void>): Promise<BenchmarkResult> {
	const runs: number[] = [];
	try {
		await fn();
		for (let i = 0; i < iterations; i++) {
			const start = nowMs();
			await fn();
			runs.push(nowMs() - start);
		}
		return { name, runs };
	} catch (error) {
		return { name, runs, error: messageOf(error) };
	}
}

async function benchmarkSandboxTransport(state: SessionState, iterations: number): Promise<string> {
	const count = Math.max(1, Math.min(20, Math.floor(iterations)));
	const benchDir = join(state.cwd, ".pi", "sbx-bench");
	const smallPath = join(benchDir, "small.txt");
	const largePath = join(benchDir, "large.bin");
	const writePath = join(benchDir, "write.txt");
	const editPath = join(benchDir, "edit.txt");
	const small = Buffer.from("pi-docker-sbx benchmark small file\n".repeat(8));
	const large = Buffer.alloc(64 * 1024, "x");

	await sbx(["exec", state.name, "mkdir", "-p", benchDir], { timeoutMs: 30_000 });
	await writeSandboxFile(state, smallPath, small);
	await writeSandboxFile(state, largePath, large);
	await writeSandboxFile(state, editPath, "before\n");

	const cases: Array<[string, () => Promise<void>]> = [
		["sbx exec true", async () => { await sbx(["exec", state.name, "true"], { timeoutMs: 30_000 }); }],
		["bash echo", async () => { await sandboxText(state, "printf bench", state.cwd); }],
		["small file read", async () => { await readSandboxFile(state, smallPath); }],
		["large file read 64KiB", async () => { await readSandboxFile(state, largePath); }],
		["write file 4KiB", async () => { await writeSandboxFile(state, writePath, Buffer.alloc(4096, "w")); }],
		["edit file", async () => {
			const current = await readSandboxFile(state, editPath);
			await writeSandboxFile(state, editPath, current.toString("utf8").replace(/before|after/g, (match) => match === "before" ? "after" : "before"));
		}],
		["grep repo", async () => {
			const command = state.capabilities?.hasRg
				? "rg --line-number --color=never --hidden -- 'AGENTS' . | head -n 100"
				: "grep -RHIn -- 'AGENTS' . | head -n 100";
			await sandboxText(state, command, state.cwd);
		}],
		["find markdown", async () => { await createSandboxFindOps(state).glob("*.md", state.cwd, { limit: 100, ignore: [] }); }],
		["real command git status", async () => { await sandboxText(state, "git status --short", state.cwd); }],
	];

	const results: BenchmarkResult[] = [];
	for (const [name, fn] of cases) results.push(await runBenchmarkCase(name, count, fn));

	const lines = [
		"# pi-docker-sbx transport benchmark",
		"",
		`Sandbox: ${state.name}`,
		`Workspace: ${state.cwd}`,
		`Iterations: ${count} measured runs per case, after one warmup run`,
		`Capabilities: ${state.capabilities ? capabilitySummary(state.capabilities) : "unknown"}`,
		"",
		"| Case | Median | Mean | Min | Max | Runs |",
		"| --- | ---: | ---: | ---: | ---: | --- |",
	];

	for (const result of results) {
		if (result.error) {
			lines.push(`| ${result.name} | error | error | error | error | ${result.error.replace(/\|/g, "\\|")} |`);
			continue;
		}
		const stats = benchmarkStats(result.runs);
		lines.push(`| ${result.name} | ${formatMs(stats.median)} ms | ${formatMs(stats.mean)} ms | ${formatMs(stats.min)} ms | ${formatMs(stats.max)} ms | ${result.runs.map(formatMs).join(", ")} |`);
	}

	const execMedian = benchmarkStats(results.find((r) => r.name === "sbx exec true")?.runs ?? []).median;
	const bashMedian = benchmarkStats(results.find((r) => r.name === "bash echo")?.runs ?? []).median;
	lines.push("", "## Worker backend decision", "");
	if (execMedian > 250 || bashMedian > 350) {
		lines.push("The measured per-call overhead is high enough that an optional persistent worker may be worth prototyping, but only behind an experimental config flag with automatic fallback to `exec`.");
	} else {
		lines.push("The measured per-call overhead does not justify a persistent worker yet. Keep the simpler `sbx exec` backend as the only implementation and revisit if real workflows show transport latency dominates command runtime.");
	}
	lines.push("", "A worker would need request ids, timeout/cancellation, streaming bash output, health checks, restart behavior, and an `exec` fallback. That complexity is intentionally deferred until benchmark data clearly pays for it.");
	return lines.join("\n") + "\n";
}

function sandboxFailureMessage(reason: string): string {
	const lower = reason.toLowerCase();
	const suggestions = ["Run `sbx diagnose` for Docker Sandbox diagnostics."];

	if (lower.includes("spawn sbx") || lower.includes("enoent") || lower.includes("not found")) {
		suggestions.unshift("Install Docker Sandboxes and make sure `sbx` is on PATH.");
	}
	if (lower.includes("login") || lower.includes("auth") || lower.includes("sign in")) {
		suggestions.unshift("Run `sbx login` to authenticate Docker Sandboxes.");
	}
	if (lower.includes("branch") || lower.includes("worktree") || lower.includes("uncommitted")) {
		suggestions.unshift("Commit or stash local changes, or retry without `--sandbox-branch`.");
	}

	return [
		"Docker Sandbox was requested, but pi-docker-sbx could not initialize it.",
		"",
		"Reason:",
		`  ${reason}`,
		"",
		"Tool execution is blocked so pi does not silently run on your host.",
		"",
		"Try:",
		...suggestions.map((suggestion) => `  - ${suggestion}`),
		"",
		"To intentionally run locally, restart pi with `--no-sandbox`.",
	].join("\n");
}

async function publishPorts(sandboxName: string, mappings: string[]): Promise<{ published: string[]; failed: string[] }> {
	const published: string[] = [];
	const failed: string[] = [];
	for (const mapping of mappings) {
		const trimmed = mapping.trim();
		if (!trimmed) continue;
		if (!/^\d+(:\d+)?$/.test(trimmed)) {
			failed.push(`${trimmed} (invalid format, expected HOST:CONTAINER or PORT)`);
			continue;
		}
		try {
			await sbx(["ports", sandboxName, "--publish", trimmed], { timeoutMs: 10_000 });
			published.push(trimmed);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failed.push(`${trimmed} (${reason})`);
		}
	}
	return { published, failed };
}

async function setEnvVars(sandboxName: string, vars: Record<string, string>): Promise<void> {
	const entries = Object.entries(vars).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
	if (entries.length === 0) return;

	const lines = entries.map(([key, value]) => `export ${key}=${shQuote(value)}`);
	const envFile = "/etc/sandbox-persistent-env-pi-docker-sbx.sh";
	const envContent = lines.join("\n") + "\n";
	await sbx(["exec", "-i", sandboxName, "bash", "-lc", `sudo tee ${shQuote(envFile)} >/dev/null`], { input: envContent });

	const sourceLine = `. ${envFile}`;
	const checkScript = `grep -qF ${shQuote(sourceLine)} /etc/sandbox-persistent.sh 2>/dev/null || printf '%s\\n' ${shQuote(sourceLine)} | sudo tee -a /etc/sandbox-persistent.sh >/dev/null`;
	await sbx(["exec", sandboxName, "bash", "-lc", checkScript]);
}

function parseEnvFlag(flag: string | undefined): { vars: Record<string, string>; invalid: string[] } {
	if (!flag) return { vars: {}, invalid: [] };
	const vars: Record<string, string> = {};
	const invalid: string[] = [];
	for (const part of flag.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) {
			invalid.push(trimmed);
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (!key || value === undefined) {
			invalid.push(trimmed);
			continue;
		}
		vars[key] = value;
	}
	return { vars, invalid };
}

function expandHostEnvVars(vars: Record<string, string>): { vars: Record<string, string>; missing: string[] } {
	const expanded: Record<string, string> = {};
	const missing: string[] = [];
	for (const [key, value] of Object.entries(vars)) {
		const match = value.match(/^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/);
		const reference = match?.[1] ?? match?.[2];
		if (!reference) {
			expanded[key] = value;
			continue;
		}
		const resolved = process.env[reference];
		if (resolved === undefined) {
			missing.push(`${key}=${value}`);
			continue;
		}
		expanded[key] = resolved;
	}
	return { vars: expanded, missing };
}

export default async function (pi: ExtensionAPI) {
	pi.registerFlag("sandbox", {
		description: "Docker Sandbox name to use (creates one if not found). Omit value to auto-create.",
		type: "string",
	});

	pi.registerFlag("no-sandbox", {
		description: "Disable Docker Sandbox delegation and use local tools",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("sandbox-branch", {
		description: "Create the Docker Sandbox in Git branch/worktree mode (use 'auto' or a branch name).",
		type: "string",
	});

	pi.registerFlag("sandbox-template", {
		description: "Docker Sandbox template image to use at create time.",
		type: "string",
	});

	pi.registerFlag("sandbox-docker", {
		description: "Use the Docker-enabled shell template for nested Docker inside the sandbox.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("sandbox-kit", {
		description: "Comma-separated Docker Sandbox kit references to apply at create time.",
		type: "string",
	});

	pi.registerFlag("sandbox-agent", {
		description: "Docker Sandbox agent to create (default: shell).",
		type: "string",
	});

	pi.registerFlag("sandbox-cpus", {
		description: "Number of CPUs to allocate when creating the sandbox.",
		type: "string",
	});

	pi.registerFlag("sandbox-memory", {
		description: "Memory limit for sandbox creation, e.g. 8g or 1024m.",
		type: "string",
	});

	pi.registerFlag("sandbox-workspaces", {
		description: "Comma-separated extra workspace paths for sandbox creation. Append :ro for read-only.",
		type: "string",
	});

	pi.registerFlag("sandbox-ports", {
		description: "Comma-separated port mappings to publish after sandbox starts, e.g. 8080:3000,5173.",
		type: "string",
	});

	pi.registerFlag("sandbox-env", {
		description: "Comma-separated KEY=VALUE pairs to set as environment variables inside the sandbox.",
		type: "string",
	});

	pi.registerCommand("sbx-bench", {
		description: "Benchmark pi-docker-sbx transport overhead (usage: /sbx-bench [iterations], default 1).",
		handler: async (args, ctx) => {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) {
				ctx.ui.notify("No active Docker Sandbox session. Start pi with --sandbox first.", "error");
				return;
			}
			const requested = Number.parseInt(args.trim(), 10);
			const iterations = Number.isFinite(requested) ? requested : 1;
			try {
				if (!(await getSandbox(state.name))) throw new Error(`No sandbox named ${state.name}. Restart pi-docker-sbx or recreate the sandbox with sbx.`);
				ctx.ui.notify(`Running pi-docker-sbx transport benchmark (${Math.max(1, Math.min(20, iterations))} iterations)...`, "info");
				const report = await benchmarkSandboxTransport(state, iterations);
				const reportDir = join(state.hostCwd, ".pi");
				const reportPath = join(reportDir, "sbx-bench-last.md");
				await mkdir(reportDir, { recursive: true });
				await writeHostFile(reportPath, report, "utf8");
				ctx.ui.notify(`pi-docker-sbx benchmark written to ${reportPath}\n\n${report}`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-docker-sbx benchmark failed: ${messageOf(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		...createReadTool(process.cwd()),
		label: "read (sbx)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			const local = createReadTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd());
			if (!state) return local.execute(id, params, signal, onUpdate);

			return createReadTool(state.cwd, { operations: createSandboxReadOps(state) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...createWriteTool(process.cwd()),
		label: "write (sbx)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) return createWriteTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate);
			return createWriteTool(state.cwd, { operations: createSandboxWriteOps(state) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...createEditTool(process.cwd()),
		label: "edit (sbx)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) return createEditTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate);
			return createEditTool(state.cwd, { operations: createSandboxEditOps(state) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...createBashTool(process.cwd()),
		label: "bash (sbx)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) return createBashTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate);
			return createBashTool(state.cwd, { operations: createSandboxBashOps(state) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...createGrepTool(process.cwd()),
		label: "grep (sbx)",
		async execute(id, params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) return createGrepTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate);

			const rawSearchPath = params.path ? stripAt(params.path) : ".";
			const searchPath = rawSearchPath.startsWith("/") ? toSandboxPath(state, rawSearchPath) : rawSearchPath;
			const limit = Math.max(1, params.limit ?? 100);
			const shellLimit = limit + 1;
			let searchCommand: string;
			if (state.capabilities?.hasRg ?? true) {
				const args = ["rg", "--line-number", "--with-filename", "--color=never", "--hidden"];
				if (params.ignoreCase) args.push("--ignore-case");
				if (params.literal) args.push("--fixed-strings");
				if (params.context && params.context > 0) args.push("--context", String(params.context));
				if (params.glob) args.push("--glob", params.glob);
				args.push("--", params.pattern, searchPath);
				searchCommand = args.map(shQuote).join(" ");
			} else {
				if (params.glob) throw new Error("grep glob filtering requires rg in the sandbox");
				const args = ["grep", "-R", "-H", "-I", "-n"];
				if (params.ignoreCase) args.push("-i");
				if (params.literal) args.push("-F");
				if (params.context && params.context > 0) args.push("-C", String(params.context));
				args.push("--", params.pattern, searchPath);
				searchCommand = args.map(shQuote).join(" ");
			}
			const script = `tmp="\${TMPDIR:-/tmp}/pi-docker-sbx-grep.$$"; trap 'rm -f "$tmp"' EXIT; ${searchCommand} >"$tmp"; status=$?; head -n ${shellLimit} "$tmp"; exit "$status"`;
			const result = await run("sbx", ["exec", "-w", state.cwd, state.name, "bash", "-lc", script], { timeoutMs: 60_000 });
			if (result.code !== 0 && result.code !== 1) {
				const reason = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || `grep exited with code ${result.code}`;
				throw new Error(reason);
			}
			const lines = result.stdout.toString("utf8").split("\n").filter(Boolean).map((line) =>
				line.startsWith(state.cwd + "/") ? line.slice(state.cwd.length + 1) : line,
			);
			const matchLimitReached = lines.length > limit;
			const text = lines.slice(0, limit).join("\n");
			const details = matchLimitReached ? { matchLimitReached: limit } : {};
			return toolText(text, "No matches found", Number.MAX_SAFE_INTEGER, details);
		},
	});

	pi.registerTool({
		...createFindTool(process.cwd()),
		label: "find (sbx)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) return createFindTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate);
			return createFindTool(state.cwd, { operations: createSandboxFindOps(state) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...createLsTool(process.cwd()),
		label: "ls (sbx)",
		async execute(id, params: { path?: string; limit?: number }, signal, onUpdate, ctx) {
			const state = activeSandbox(ctx as ExtensionContext | undefined);
			if (!state) return createLsTool((ctx as ExtensionContext | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate);

			const listPath = params.path ? toSandboxPath(state, params.path) : state.cwd;
			const limit = Math.max(1, params.limit ?? 500);
			const script = `dir=${shQuote(listPath)}; if [ ! -e "$dir" ]; then printf 'Path not found: %s\\n' "$dir" >&2; exit 2; fi; if [ ! -d "$dir" ]; then printf 'Not a directory: %s\\n' "$dir" >&2; exit 3; fi; ls -A1p -- "$dir" | sort -f`;
			const result = await run("sbx", ["exec", state.name, "bash", "-lc", script], { timeoutMs: 60_000 });
			if (result.code !== 0) {
				const reason = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || `ls exited with code ${result.code}`;
				throw new Error(reason);
			}
			const entries = result.stdout.toString("utf8").split("\n").filter(Boolean);
			const entryLimitReached = entries.length > limit;
			const text = entries.slice(0, limit).join("\n");
			const details = entryLimitReached ? { entryLimitReached: limit } : {};
			return toolText(text, "(empty directory)", Number.MAX_SAFE_INTEGER, details);
		},
	});

	pi.on("user_bash", (_event, ctx) => {
		const state = getState(ctx);
		if (state?.error) return { result: { output: state.error + "\n", exitCode: 1, cancelled: false, truncated: false } };
		if (!state?.enabled) return;
		return { operations: createSandboxBashOps(state) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = getState(ctx);
		if (!state?.enabled) return;

		return { systemPrompt: event.systemPrompt + sandboxEnvironmentBlock(state, await sandboxContextFiles(state)) };
	});

	pi.on("resources_discover", async (_event, ctx) => {
		const state = getState(ctx);
		if (!state?.enabled) return;
		return sandboxResourcePaths(state);
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessions.has(sessionId)) return;

		if (pi.getFlag("no-sandbox") as boolean) {
			ctx.ui.notify("Docker Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const sandboxFlag = pi.getFlag("sandbox") as string | undefined;
		if (sandboxFlag === undefined) return;

		try {
			await sbx(["version"], { timeoutMs: 10_000 });
			const config = await loadConfig(ctx.cwd);
			const rawName = sandboxFlag || config.defaultSandbox || randomSuffix();
			const name = prefixedName(rawName);
			const cpusFlag = pi.getFlag("sandbox-cpus") as string | undefined;
			const createOptions: CreateOptions = {
				agent: (pi.getFlag("sandbox-agent") as string | undefined) || config.agent || "shell",
				template:
					(pi.getFlag("sandbox-template") as string | undefined) ||
					((pi.getFlag("sandbox-docker") as boolean) ? "docker.io/docker/sandbox-templates:shell-docker" : config.template),
				branch: (pi.getFlag("sandbox-branch") as string | undefined) || config.branch,
				cpus: cpusFlag !== undefined ? Number.parseInt(cpusFlag, 10) : config.cpus,
				memory: (pi.getFlag("sandbox-memory") as string | undefined) || config.memory,
				kits: [...(config.kits ?? []), ...listFlag(pi.getFlag("sandbox-kit"))],
				extraWorkspaces: [...(config.extraWorkspaces ?? []), ...listFlag(pi.getFlag("sandbox-workspaces"))],
			};
			ctx.ui.notify(`Ensuring Docker Sandbox ${name}...`, "info");
			const ensured = await ensureSandbox(name, ctx.cwd, createOptions);
			const capabilities = await checkSandboxCapabilities(name, ensured.workspace);
			const capabilityError = criticalCapabilityError(ensured.workspace, capabilities);
			if (capabilityError) throw new Error(capabilityError);

			// Publish ports (flag + config)
			const portMappings = [...(config.ports ?? []), ...listFlag(pi.getFlag("sandbox-ports"))];
			const { published: publishedPorts, failed: failedPorts } = await publishPorts(name, portMappings);

			// Set custom environment variables (flag + config)
			const envFromConfig = config.env ?? {};
			const envFromFlag = parseEnvFlag(pi.getFlag("sandbox-env") as string | undefined);
			const expandedEnv = expandHostEnvVars({ ...envFromConfig, ...envFromFlag.vars });
			const envVars = expandedEnv.vars;
			if (envFromFlag.invalid.length > 0) {
				ctx.ui.notify(`Skipped invalid environment entries: ${envFromFlag.invalid.join(", ")}`, "warning");
			}
			if (expandedEnv.missing.length > 0) {
				ctx.ui.notify(`Skipped environment variables with missing host values: ${expandedEnv.missing.join(", ")}`, "warning");
			}
			const invalidNames = Object.keys(envVars).filter((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
			if (invalidNames.length > 0) {
				ctx.ui.notify(`Skipped invalid environment variable names: ${invalidNames.join(", ")}`, "warning");
			}
			const validEntries = Object.entries(envVars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
			if (validEntries.length > 0) {
				await setEnvVars(name, Object.fromEntries(validEntries));
			}

			sessions.set(sessionId, { name, hostCwd: ctx.cwd, cwd: ensured.workspace, enabled: true, capabilities, branch: createOptions.branch });

			// Update status bar
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🐳 Sandbox: ${name}${createOptions.branch ? ` | ${createOptions.branch}` : ""} | ${capabilitySummary(capabilities)}`));

			// Single startup notification
			const parts = [`${ensured.existed ? "Connected to" : "Created"} Docker Sandbox: ${name}`];
			if (createOptions.branch) parts.push(`(branch: ${createOptions.branch})`);
			if (publishedPorts.length > 0) parts.push(`ports: ${publishedPorts.join(", ")}`);
			if (validEntries.length > 0) parts.push(`env: ${validEntries.length} vars`);
			parts.push(`capabilities: ${capabilitySummary(capabilities)}`);
			ctx.ui.notify(parts.join(" "), "info");

			if (failedPorts.length > 0) {
				ctx.ui.notify(`Failed to publish ports: ${failedPorts.join("; ")}`, "warning");
			}
			if (!createOptions.branch) {
				ctx.ui.notify("Direct mode: workspace changes are written to the host tree. Use --sandbox-branch auto for isolation.", "warning");
			}
		} catch (error) {
			const reason = messageOf(error);
			const message = sandboxFailureMessage(reason);
			sessions.set(sessionId, { name: sandboxFlag ? prefixedName(sandboxFlag) : "pi-docker-sbx-unavailable", hostCwd: ctx.cwd, cwd: ctx.cwd, enabled: false, error: message });
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "🐳 Sandbox unavailable"));
			ctx.ui.notify(message, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessions.delete(ctx.sessionManager.getSessionId());
	});
}
