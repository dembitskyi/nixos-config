# Centralized AI agent skills.
#
# On each rebuild the activation script clones missing skill repos into the
# cache directory and copies them into every configured destination. The
# `update-skills` command refreshes the cache; run `update` afterwards to
# redistribute the updated cache to the destinations.
#
# The default `sources` list below ships with a curated set of known-good
# skill repositories. Hosts opt in by setting `enable = true` and may extend
# the defaults via `sources = [ ... ]` (lists are concatenated by the module
# system).
#
# Notable repos intentionally excluded from the defaults (opt in per host):
#   - majiayu000/claude-skill-registry: ships with ~170MB of registry/notice
#     blobs alongside its `skills/` tree; clone size is prohibitive.
#   - tech-leads-club/agent-skills: nx monorepo, skills are not laid out under
#     `skills/` and need a custom subpath.
#   - heilcheng/awesome-agent-skills: directory listing only, no SKILL.md files.
#
# Layouts:
#   skills-subdir  — repo has `skills/<name>/` directories.
#   marker         — repo has `<name>/SKILL.md` directories at root.
#   single         — entire repo is one skill (SKILL.md at root). Deployed under repo `name`.
#   nested         — find every `SKILL.md` recursively, deploy each parent dir.
#   subpath        — like `skills-subdir` but rooted at `subpath` instead of `skills/`.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.ai-skills;

  sourceType = lib.types.submodule {
    options = {
      name = lib.mkOption {
        type = lib.types.str;
        description = "Cache directory name and (for `single` layout) deployed skill name.";
      };
      url = lib.mkOption {
        type = lib.types.str;
        description = "Git URL to clone.";
      };
      layout = lib.mkOption {
        type = lib.types.enum [
          "skills-subdir"
          "marker"
          "single"
          "nested"
          "subpath"
        ];
        description = "How skills are organized inside the repo.";
      };
      subpath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Required for `subpath` layout: directory inside the repo that contains skill subdirs.";
      };
    };
  };

  # Quote for embedding into shell scripts.
  shQuote = s: "'${lib.replaceStrings [ "'" ] [ "'\\''" ] s}'";

  # Render the source list as a bash array of pipe-separated entries.
  # Each entry: "<name>|<url>|<layout>|<subpath>".
  allSources = cfg.sources ++ cfg.extraSources;
  sourcesArrayLines = lib.concatMapStringsSep "\n" (
    s: "  ${shQuote "${s.name}|${s.url}|${s.layout}|${if s.subpath == null then "" else s.subpath}"}"
  ) allSources;

  destinationsArrayLines = lib.concatMapStringsSep "\n" (d: "  ${shQuote d}") cfg.destinations;

  # Cache root as a shell expression. The literal `$HOME` is intentional —
  # it must be expanded by bash at activation time, not by Nix.
  cacheRootShell = ''"$HOME/${cfg.cacheDir}"'';

  # Activation helpers: bash functions used by the activation script to copy
  # cached repos into each destination according to layout.
  activationHelpers = ''
    _all_dests() {
      for dest_rel in "''${destinations[@]}"; do
        printf '%s\n' "$HOME/$dest_rel"
      done
    }

    # Copy each immediate subdir of $1 into every destination, named after the subdir.
    _copy_skills_subdir() {
      local src="$1"
      [ -d "$src" ] || return 0
      while IFS= read -r dest; do
        $DRY_RUN_CMD mkdir -p "$dest"
        for skill_dir in "$src"/*/; do
          [ -d "$skill_dir" ] || continue
          local name
          name=$(${pkgs.coreutils}/bin/basename "$skill_dir")
          $DRY_RUN_CMD rm -rf "$dest/$name"
          $DRY_RUN_CMD cp -r "$skill_dir" "$dest/$name"
        done
      done < <(_all_dests)
    }

    # Like _copy_skills_subdir but only copies subdirs that contain SKILL.md.
    _copy_skills_marker() {
      local src="$1"
      [ -d "$src" ] || return 0
      while IFS= read -r dest; do
        $DRY_RUN_CMD mkdir -p "$dest"
        for skill_dir in "$src"/*/; do
          [ -f "$skill_dir/SKILL.md" ] || continue
          local name
          name=$(${pkgs.coreutils}/bin/basename "$skill_dir")
          $DRY_RUN_CMD rm -rf "$dest/$name"
          $DRY_RUN_CMD cp -r "$skill_dir" "$dest/$name"
        done
      done < <(_all_dests)
    }

    # Whole repo is one skill. Copies SKILL.md plus common adjunct files into
    # each destination under $2 (the source `name`).
    _copy_skills_single() {
      local src="$1" name="$2"
      [ -f "$src/SKILL.md" ] || return 0
      while IFS= read -r dest; do
        $DRY_RUN_CMD mkdir -p "$dest/$name"
        $DRY_RUN_CMD cp "$src/SKILL.md" "$dest/$name/SKILL.md"
        for f in README.md LICENSE LICENSE.md CHANGELOG.md; do
          if [ -f "$src/$f" ]; then
            $DRY_RUN_CMD cp "$src/$f" "$dest/$name/$f"
          fi
        done
        for d in references scripts assets templates examples; do
          if [ -d "$src/$d" ]; then
            $DRY_RUN_CMD cp -r "$src/$d" "$dest/$name/$d"
          fi
        done
      done < <(_all_dests)
    }

    # Walk the repo, copy every directory that contains a SKILL.md.
    _copy_skills_nested() {
      local src="$1"
      [ -d "$src" ] || return 0
      ${pkgs.findutils}/bin/find "$src" -name SKILL.md -type f -print0 2>/dev/null | \
        while IFS= read -r -d "" marker; do
          local skill_dir name
          skill_dir=$(${pkgs.coreutils}/bin/dirname "$marker")
          name=$(${pkgs.coreutils}/bin/basename "$skill_dir")
          while IFS= read -r dest; do
            $DRY_RUN_CMD mkdir -p "$dest"
            $DRY_RUN_CMD rm -rf "$dest/$name"
            $DRY_RUN_CMD cp -r "$skill_dir" "$dest/$name"
          done < <(_all_dests)
        done
    }
  '';

  # Shell script that pulls every configured source into the cache.
  # Returns 0 if nothing changed, 2 if at least one repo was cloned or updated.
  updateSkills = pkgs.writeShellScriptBin "update-skills" ''
    set -u

    sources=(
    ${sourcesArrayLines}
    )

    cache_root=${cacheRootShell}
    cloned=0
    updated=0
    total=0

    echo ""
    echo "══════════════════════════════════════════"
    echo "  AI Skills Update"
    echo "══════════════════════════════════════════"

    if [ ''${#sources[@]} -eq 0 ]; then
      echo "  No sources configured."
      echo "  Add entries to mine.home.ai-skills.sources."
      exit 0
    fi

    for entry in "''${sources[@]}"; do
      IFS='|' read -r name url layout subpath <<< "$entry"
      total=$((total + 1))
      dir="$cache_root/$name"

      if [ ! -d "$dir/.git" ]; then
        echo "  Cloning: $name"
        ${pkgs.coreutils}/bin/mkdir -p "$cache_root"
        if ${pkgs.git}/bin/git clone --quiet "$url" "$dir"; then
          cloned=$((cloned + 1))
        else
          echo "  Failed:  $name"
          continue
        fi
      else
        before=$(${pkgs.git}/bin/git -C "$dir" rev-parse HEAD 2>/dev/null)
        if ${pkgs.git}/bin/git -C "$dir" pull --ff-only --quiet 2>/dev/null; then
          after=$(${pkgs.git}/bin/git -C "$dir" rev-parse HEAD 2>/dev/null)
          if [ "$before" != "$after" ]; then
            echo "  Updated: $name"
            updated=$((updated + 1))
          fi
        else
          echo "  Failed:  $name (pull)"
        fi
      fi
    done

    echo ""
    if [ $cloned -gt 0 ] || [ $updated -gt 0 ]; then
      [ $cloned  -gt 0 ] && echo "  Cloned:  $cloned new repo(s)"
      [ $updated -gt 0 ] && echo "  Updated: $updated repo(s)"
      echo "  Total:   $total skill repo(s)"
      echo ""
      echo "  Run \`update\` to redistribute the updated cache."
      exit 2
    else
      echo "  All $total skill repo(s) up to date."
      exit 0
    fi
  '';

  # home.file entries for inline skills, replicated across every destination.
  inlineFiles = lib.foldl' (
    acc: dest:
    acc
    // lib.mapAttrs' (
      name: text: lib.nameValuePair "${dest}/${name}/SKILL.md" { inherit text; }
    ) cfg.inlineSkills
  ) { } cfg.destinations;
in
{
  options.mine.home.ai-skills = {
    enable = lib.mkEnableOption "AI agent skills (cache + redistribute)";

    destinations = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ".config/opencode/skills" ];
      description = ''
        Skill destination directories, relative to $HOME. Cached skills are
        copied into each destination on activation. Inline skills are written
        into each destination via home.file.
      '';
    };

    cacheDir = lib.mkOption {
      type = lib.types.str;
      default = ".cache/ai-skills";
      description = "Cache directory (relative to $HOME) where source repos are cloned.";
    };

    sources = lib.mkOption {
      type = lib.types.listOf sourceType;
      default = [
        # Official.
        {
          name = "anthropics";
          url = "https://github.com/anthropics/skills";
          layout = "skills-subdir";
        }

        # Vendor / framework skill collections.
        {
          name = "gemini";
          url = "https://github.com/google-gemini/gemini-skills";
          layout = "skills-subdir";
        }
        {
          name = "huggingface";
          url = "https://github.com/huggingface/skills";
          layout = "skills-subdir";
        }
        {
          name = "cloudflare";
          url = "https://github.com/cloudflare/skills";
          layout = "skills-subdir";
        }
        {
          name = "supabase";
          url = "https://github.com/supabase/agent-skills";
          layout = "skills-subdir";
        }
        {
          name = "neon";
          url = "https://github.com/neondatabase/agent-skills";
          layout = "skills-subdir";
        }
        {
          name = "vercel";
          url = "https://github.com/vercel-labs/agent-skills";
          layout = "skills-subdir";
        }
        {
          name = "pg-aiguide";
          url = "https://github.com/timescale/pg-aiguide";
          layout = "skills-subdir";
        }
        {
          name = "runpod";
          url = "https://github.com/runpod/skills";
          layout = "marker";
        }
        {
          name = "clerk";
          url = "https://github.com/clerk/skills";
          layout = "nested";
        }
        {
          name = "fal-ai";
          url = "https://github.com/fal-ai-community/skills";
          layout = "subpath";
          subpath = "skills/claude.ai";
        }
        {
          name = "svelte";
          url = "https://github.com/sveltejs/ai-tools";
          layout = "subpath";
          subpath = "plugins/svelte/skills";
        }

        # Community curated collections.
        {
          name = "addyosmani";
          url = "https://github.com/addyosmani/agent-skills";
          layout = "skills-subdir";
        }
        {
          name = "antigravity-awesome";
          url = "https://github.com/sickn33/antigravity-awesome-skills";
          layout = "skills-subdir";
        }
        {
          name = "alirezarezvani";
          url = "https://github.com/alirezarezvani/claude-skills";
          layout = "nested";
        }

        # Single-skill repos (whole repo deployed as one skill).
        {
          name = "hyprland";
          url = "https://github.com/marceloeatworld/hyprland-ai-skill";
          layout = "single";
        }
        {
          name = "nixos";
          url = "https://github.com/marceloeatworld/nixos-ai-skill";
          layout = "single";
        }
      ];
      description = "Skill source repositories to clone and redistribute.";
    };

    extraSources = lib.mkOption {
      type = lib.types.listOf sourceType;
      default = [ ];
      description = ''
        Additional skill sources, concatenated with `sources`. Use this to add
        sources without overriding the curated `sources` default (e.g. from
        other modules).
      '';
    };

    inlineSkills = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Inline SKILL.md content. Keys are skill directory names, values are the
        full SKILL.md text (including YAML frontmatter).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ updateSkills ];

    home.file = inlineFiles;

    home.activation.installAiSkills = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      destinations=(
      ${destinationsArrayLines}
      )

      cache_root=${cacheRootShell}

      _ai_skills_log() { echo "[ai-skills] $*"; }

      _ai_skills_count() {
        local dest="$1"
        if [ -d "$dest" ]; then
          ${pkgs.findutils}/bin/find "$dest" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | ${pkgs.coreutils}/bin/wc -l
        else
          echo 0
        fi
      }

      _ai_skills_log "cache:        $cache_root"
      for dest_rel in "''${destinations[@]}"; do
        _ai_skills_log "destination:  $HOME/$dest_rel"
      done

      ${activationHelpers}

      ai_skills_total=0
      ai_skills_cloned=0
      ai_skills_failed=0

      ${lib.concatMapStringsSep "\n\n" (
        s:
        let
          # Paths are built in shell so $HOME expands at activation time.
          dirShell = ''"$cache_root/${s.name}"'';
          cloneCmd = ''
            if [ ! -d ${dirShell}/.git ]; then
              _ai_skills_log "clone:        ${s.name} (${s.url})"
              $DRY_RUN_CMD ${pkgs.coreutils}/bin/mkdir -p "$cache_root"
              if $DRY_RUN_CMD ${pkgs.git}/bin/git clone --quiet ${shQuote s.url} ${dirShell}; then
                ai_skills_cloned=$((ai_skills_cloned + 1))
              else
                _ai_skills_log "FAILED clone: ${s.name}"
                ai_skills_failed=$((ai_skills_failed + 1))
              fi
            fi
          '';
          dispatch =
            {
              skills-subdir = ''_copy_skills_subdir "$cache_root/${s.name}/skills"'';
              marker = "_copy_skills_marker ${dirShell}";
              single = "_copy_skills_single ${dirShell} ${shQuote s.name}";
              nested = "_copy_skills_nested ${dirShell}";
              subpath = ''_copy_skills_subdir "$cache_root/${s.name}/${toString s.subpath}"'';
            }
            .${s.layout};
        in
        ''
          # ── ${s.name} (${s.layout}) ──
          ai_skills_total=$((ai_skills_total + 1))
          ${cloneCmd}
          if ! ${dispatch}; then
            _ai_skills_log "FAILED copy:  ${s.name}"
            ai_skills_failed=$((ai_skills_failed + 1))
          fi
        ''
      ) allSources}

      for dest_rel in "''${destinations[@]}"; do
        _ai_skills_log "deployed:     $(_ai_skills_count "$HOME/$dest_rel") skill(s) in $HOME/$dest_rel"
      done
      _ai_skills_log "summary:      $ai_skills_total source(s), $ai_skills_cloned newly cloned, $ai_skills_failed failed"
    '';
  };
}
