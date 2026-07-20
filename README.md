# PromptPad

PromptPad is a desktop developer tool for selecting source files and assembling
their contents into a structured prompt. It works with local projects and remote
SSH workspaces, helping developers provide focused code context without manually
copying files one by one.

## Highlights

- Browse local project trees and select files or directories
- Discover related imports and reverse dependencies
- Add a personal instruction alongside source context
- Preview prompt size before copying the result
- Save multiple project tabs locally
- Connect to SSH servers with password or private-key authentication
- Browse, read, select, and download remote files through a Rust backend

## Technology

- React 19 and TypeScript
- Vite
- Tauri 2
- Rust SSH and filesystem commands
- Native clipboard, file-dialog, and filesystem integrations

## Run locally

Install Node.js and the Tauri prerequisites for your operating system, then run:

```bash
npm install
npm run tauri dev
```

Web-interface development is also available with:

```bash
npm run dev
```

## Security notes

PromptPad reads files selected by the user. Review generated prompts before
sharing them and do not include secrets, private keys, environment files, or
customer data. SSH credentials should never be committed to this repository.

## Current status

The core local and SSH workflows are implemented. Planned work includes breaking
the main interface into smaller modules, automated tests, credential-storage
hardening, CI, screenshots, and packaged releases.
