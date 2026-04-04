{
  description = "octto — interactive brainstorming plugin for OpenCode";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    {
      nixpkgs,
      systems,
      ...
    }:
    let
      eachSystem = f: nixpkgs.lib.genAttrs (import systems) (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            # Runtime & package manager
            bun

            # Node.js — needed by tsc (via typescript devDep) and @opencode-ai/plugin
            nodejs_22

            # Build / lint (also installed via bun but handy on PATH for editors)
            biome
            lefthook

            # Nix tooling
            nil # nix LSP
            nixfmt-rfc-style
          ];

          shellHook = ''
            echo "octto dev shell"
            echo "  bun  $(bun --version)"
            echo "  node $(node --version)"

            # Install deps if node_modules is missing or stale
            if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json 2>/dev/null ]; then
              echo "→ running bun install..."
              bun install --frozen-lockfile 2>/dev/null || bun install
            fi

            # Make devDep binaries available (tsc, eslint, etc.)
            export PATH="$PWD/node_modules/.bin:$PATH"
          '';
        };
      });
    };
}
