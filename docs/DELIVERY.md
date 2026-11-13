# Delivering task packages

Each Stage A task is one ZIP file containing the files for that task and a `TASK.json` manifest
(task id, required previous task, and the path, size and SHA-256 of every file).

## First import (task A1, empty repository)

1. Create the repository on GitHub and enable Actions.
2. In **Settings > Actions > General > Workflow permissions**, choose "Read and write permissions" and tick
   "Allow GitHub Actions to create and approve pull requests". The import workflow cannot open pull requests without this.
3. Upload the A1 ZIP into a folder named `imports/` on the main branch (Add file > Upload files; the file name must match `imports/<letters digits . _ ->.zip`).
4. Create `.github/workflows/import.yml` (Add file > Create new file) with the content of `import.yml` shipped next to the ZIP. This one file is pasted by hand because the workflow does not exist yet.
5. Run **Actions > Import task package > Run workflow** with `zip_path = imports/<file>.zip` and `bootstrap` ticked.
6. Review the pull request the workflow opens (the exact diff is shown before anything is committed) and merge it.

## Every later task

1. Upload the task ZIP to `imports/` on main.
2. Run the import workflow with `zip_path` set and `bootstrap` unticked.
3. Review and merge the pull request.

## What the workflow checks

- ZIP structure: no absolute paths, `..` segments, backslashes, empty segments, symbolic links, devices, FIFOs, duplicate or case-colliding names, encrypted entries, zip64, overlapping entries, oversize or highly compressed entries.
- Scope: only allowlisted folders and file types; files must be declared in the manifest and inside the prefixes the task declares; the manifest cannot widen the allowlist.
- Protected files cannot be changed by an import: `.github/workflows/import.yml`, `tools/import/`, `tasks/state.json`. (Only the bootstrap import of A1 may add the import tooling.)
- Every file hash and size must match `TASK.json`; no secrets (token patterns, private keys, `.env` files); no `package.json` install-time scripts.
- Task order: a task is rejected unless the task it requires has been imported, and a task id cannot be imported twice.
- Validation runs in a read-only job. A second job applies the files in a working copy, runs lint and tests, and opens a pull request. Nothing is pushed to the main branch directly.

Packages must never contain secrets or credentials.
