{
  description = "Development environment for YonDrive";

  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    flake-utils,
    nixpkgs,
  }: flake-utils.lib.eachDefaultSystem (system: let
    pkgs = import nixpkgs { inherit system; };
  in {
    devShells.default = pkgs.mkShell {
      packages = with pkgs; [
        # Go server
        go
        gopls
        gotools          # goimports, stringer, ...
        golangci-lint
        delve
        oapi-codegen     # Go code from the OpenAPI spec
        sqlite           # inspecting yondrive.db

        # SvelteKit frontend
        nodejs_22
        pnpm
        # Browsers for the Playwright e2e. @playwright/test in web/package.json
        # must be the exact version of playwright-driver here.
        playwright-driver.browsers
        redocly          # OpenAPI lint

        # Misc
        just
      ];

      # Keep Go's module cache and build cache inside the project so a
      # fresh clone or a CI runner does not pollute $HOME.
      shellHook = ''
        export GOPATH="$PWD/.go"
        export GOMODCACHE="$GOPATH/pkg/mod"
        export GOCACHE="$GOPATH/cache"
        export PATH="$GOPATH/bin:$PATH"
        export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
        export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
        export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

        # Load project env files: .env for shared vars (checked in),
        # .env.local for private overrides (gitignored).
        for f in .env .env.local; do
          if [ -f "$f" ]; then
            set -a
            . "$f"
            set +a
          fi
        done
      '';
    };

    formatter = pkgs.nixfmt-rfc-style;
  });
}
