# pi-docker-sbx

Run pi safely inside a [Docker Sandbox](https://docker.com) via the `sbx` CLI. Every file read, write, shell command, and search runs in an isolated Docker microVM — your local machine is never touched.

## Why sandboxing?

When pi edits files or runs bash commands, it operates directly on your machine. A sandbox moves all of that into a secure, disposable Docker environment. If the AI does something unexpected, your real filesystem stays safe. Think of it as a safety net — you can experiment freely and throw the sandbox away when you're done.

## Setup

**1. Install the Docker Sandbox CLI**

```bash
# macOS
brew install docker/sandbox/sbx

# Or download directly
# https://github.com/docker/sbx/releases
```

Make sure `sbx` is available on your PATH:

```bash
sbx --help
sbx login
```

**2. Configure pi**

Create `~/.pi/sbx.json`:

```json
{
  "defaultSandbox": "my-project",
  "branch": "auto"
}
```

**3. Install**

```bash
pi install npm:pi-docker-sbx
```

## Usage

```bash
# Create a fresh sandbox
pi --sandbox

# Create a named sandbox you can return to
pi --sandbox my-project

# Reconnect to an existing sandbox
pi --sandbox my-project

# Branch/worktree mode: changes land in an isolated Git worktree under .sbx/
pi --sandbox my-project --sandbox-branch auto

# Disable sandboxing for a session
pi --sandbox --no-sandbox
```

Once connected, pi works exactly the same — just safer. All file operations and commands run inside the Docker Sandbox. The status bar shows your sandbox name and capabilities.

## Configuration

`pi-docker-sbx` reads config from both locations, with project config overriding global config:

- `~/.pi/sbx.json`
- `.pi/sbx.json`

Minimal recommended config:

```json
{
  "defaultSandbox": "my-project",
  "branch": "auto"
}
```

Full config with all options (see `sbx.example.json`):

```json
{
  "defaultSandbox": "my-project",
  "agent": "shell",
  "template": "docker.io/docker/sandbox-templates:shell-docker",
  "branch": "auto",
  "cpus": 4,
  "memory": "8g",
  "kits": [],
  "ports": ["8080:3000"],
  "env": {
    "BRAVE_API_KEY": "$BRAVE_API_KEY"
  },
  "extraWorkspaces": []
}
```

CLI flags override or extend config:

```bash
pi --sandbox my-project --sandbox-branch auto
pi --sandbox my-project --sandbox-template docker.io/docker/sandbox-templates:shell-docker
pi --sandbox my-project --sandbox-docker
pi --sandbox my-project --sandbox-kit ./pi-agent
pi --sandbox my-project --sandbox-workspaces /path/to/docs:ro,/path/to/lib
pi --sandbox my-project --sandbox-cpus 4 --sandbox-memory 8g
pi --sandbox my-project --sandbox-ports 8080:3000,5173
pi --sandbox my-project --sandbox-env BRAVE_API_KEY=xxx,MY_TOKEN=yyy
```

## Port forwarding

Docker Sandboxes are network-isolated. Use `--sandbox-ports` or `"ports"` in config to auto-publish ports when the sandbox starts:

```bash
pi --sandbox my-project --sandbox-ports 8080:3000
```

Or in `.pi/sbx.json`:

```json
{
  "ports": ["8080:3000", "5173"]
}
```

The agent is automatically told about published ports in its system prompt and will bind dev servers to `0.0.0.0` so they're reachable.

You can also manage ports manually at any time:

```bash
sbx ports my-project --publish 8080:3000
sbx ports my-project --unpublish 8080:3000
sbx ports my-project   # list current mappings
```

## Custom environment variables

Set environment variables inside the sandbox that persist across agent sessions. Useful for API keys not covered by `sbx secret`:

```bash
pi --sandbox my-project --sandbox-env BRAVE_API_KEY=xxx,MY_TOKEN=yyy
```

Or in `.pi/sbx.json`:

```json
{
  "env": {
    "BRAVE_API_KEY": "$BRAVE_API_KEY",
    "MY_TOKEN": "hardcoded-value"
  }
}
```

Values written as `$NAME` or `${NAME}` are resolved from your host environment. Missing host values are skipped with a warning. This keeps secrets out of config files you might commit.

> **Note:** Unlike `sbx secret`, which injects credentials through a host-side proxy without exposing them to the agent, env vars set this way are stored inside the sandbox. The agent process can read them directly.

## Sandbox preflight

After creating or starting the sandbox, `pi-docker-sbx` runs a fail-closed preflight before enabling delegated tools. It verifies that the workspace is mounted and writable, and that required utilities such as `bash`, `base64`, `cat`, `mkdir`, `ls`, `head`, and either `rg` or `grep` are available.

Non-critical capabilities like `rg`, `file`, `find`, and whether the workspace is a Git repo are recorded in the status/system prompt and used to choose tool fallbacks.

## Tools overridden

- `read`
- `write`
- `edit`
- `bash`
- `grep`
- `find`
- `ls`
- user `!bash`

## All CLI flags

| Flag | Type | Description |
|------|------|-------------|
| `--sandbox [name]` | string | Sandbox name (auto-create if omitted) |
| `--no-sandbox` | boolean | Disable sandbox, use local tools |
| `--sandbox-branch` | string | Git worktree mode (`auto` or branch name) |
| `--sandbox-template` | string | Custom template image |
| `--sandbox-docker` | boolean | Use Docker-enabled shell template |
| `--sandbox-kit` | string | Comma-separated kit references |
| `--sandbox-agent` | string | Sandbox agent (default: `shell`) |
| `--sandbox-cpus` | string | CPU count |
| `--sandbox-memory` | string | Memory limit (e.g., `8g`) |
| `--sandbox-workspaces` | string | Extra workspace paths (`:ro` for read-only) |
| `--sandbox-ports` | string | Port mappings to publish (e.g., `8080:3000`) |
| `--sandbox-env` | string | Environment variables (`KEY=VAL,...`) |

## Requirements

- Node.js ≥ 18
- Docker Sandbox CLI (`sbx`) installed and logged in

## License

MIT
