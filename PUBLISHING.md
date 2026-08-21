# Publishing CodeRelay

Release checklist for the Visual Studio Marketplace. Everything here is manual on
purpose: publishing is outward-facing and should not happen as a side effect of CI.

## One-time setup

1. Create the **`bakullabs`** publisher at
   <https://marketplace.visualstudio.com/manage>. The `publisher` field in
   `package.json` must match this id exactly, or `vsce publish` fails.
2. Create a Personal Access Token in Azure DevOps for the same account:
   **All accessible organizations**, scope **Marketplace → Manage**.
3. `pnpm exec vsce login bakullabs` and paste the token.

## Each release

1. Bump `version` in `package.json` (semver).
2. Add the release section to `CHANGELOG.md`. Only list what actually shipped.
3. Verify locally:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run package        # clean -> typecheck -> test -> compile -> vsce package
   ```

   `pnpm run package` refuses to produce a VSIX if the typecheck or the 389-test
   suite fails, so a red suite cannot be published by accident.

4. Install the built artefact and click through it once in a real window —
   activation, `CodeRelay: Add API Key`, `CodeRelay: Start Task`:

   ```sh
   code --install-extension coderelay-<version>.vsix --force
   ```

5. Publish:

   ```sh
   pnpm exec vsce publish
   ```

## What ships

`out/src/**`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `icon.png` —
and nothing else. `.vscodeignore` excludes sources, tests, tsconfigs, `docs/`,
CI config and `node_modules`. To confirm before publishing:

```sh
pnpm exec vsce ls --tree
```

## Notes

- The extension has **zero runtime dependencies**, so `--no-dependencies` is
  correct and `node_modules` is never packaged.
- `extensionKind: ["workspace"]` and `capabilities.virtualWorkspaces: false` are
  deliberate: CodeRelay shells out to `git` and resolves real filesystem paths,
  so it must run where the workspace is and cannot run on a virtual filesystem.
- Never commit a PAT. `vsce login` stores it outside the repository.
