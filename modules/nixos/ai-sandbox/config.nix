{
  lib,
  pkgs,
  config,
  placeholder,
  proxyEnv ? false,
  automationConfig ? { },
  telemetryOptOut ? { },
}:
let
  fastmcpCli = lib.getExe' (pkgs.python313.withPackages (ps: [ ps.fastmcp ])) "fastmcp";
  opencode = lib.getExe pkgs.opencode;
  proxyCfg = config.mine.ai-sandbox.proxy;
  # Inline env prefix applied only to opencode processes.
  proxyPrefix =
    if proxyEnv then
      "HTTP_PROXY=http://127.0.0.1:${toString proxyCfg.port} HTTPS_PROXY=http://127.0.0.1:${toString proxyCfg.port} NO_PROXY=127.0.0.1,localhost "
    else
      "";
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  # Shared by both opencode servers and their clients (see opencode-sandbox).
  passwordFile = "${userHome}/.local/share/opencode/sandbox-server.password";
  helpers = import ./helpers.nix {
    inherit lib pkgs;
  };
  inherit (helpers)
    npxServer
    npxServerWithEnv
    uvxServerWithEnv
    ;

  browseruse-conf = pkgs.writeText "browseruse.conf" ''
    {
      "browser_profile": {
        "fe352f2b-c9ab-41b5-bd14-d315cd952404": {
          "id": "fe352f2b-c9ab-41b5-bd14-d315cd952404",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268569",
          "headless": false,
          "user_data_dir": null,
          "allowed_domains": null,
          "downloads_path": null,
          "cdp_url": "http://127.0.0.1:9222"
        }
      },
      "llm": {
        "85b108a4-a573-4f6c-b739-f605553f66ce": {
          "id": "85b108a4-a573-4f6c-b739-f605553f66ce",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268580",
          "api_key": null,
          "provider": "${config.mine.ai-sandbox.browseruse.provider}",
          "model": "${config.mine.ai-sandbox.browseruse.opencode.model}",
          "host": null
        }
      },
      "agent": {
        "02a2dfdb-d7da-4f48-acae-2766ea324d0d": {
          "id": "02a2dfdb-d7da-4f48-acae-2766ea324d0d",
          "default": true,
          "created_at": "2026-03-05T07:13:24.268586",
          "max_steps": null,
          "use_vision": null,
          "system_prompt": null
        }
      }
    }
  '';

  defaultServerOrder = [
    "github"
    "jira"
    "context7"
    "playwright"
  ]
  ++ lib.optional config.mine.ai-sandbox.browseruse.enable "browseruse"
  ++ lib.optional config.mine.ai-sandbox.ghidra.enable "ghidra";

  builtInServers = {
    # Developer Tools
    github = npxServerWithEnv "@modelcontextprotocol/server-github" {
      GITHUB_PERSONAL_ACCESS_TOKEN = placeholder."MCP/GITHUB_TOKEN";
    };
    jira = uvxServerWithEnv "mcp-atlassian" {
      JIRA_URL = placeholder."MCP/JIRA_URL";
      JIRA_USERNAME = placeholder."MCP/JIRA_USERNAME";
      JIRA_API_TOKEN = placeholder."MCP/JIRA_API_TOKEN";
      CONFLUENCE_URL = placeholder."MCP/CONFLUENCE_URL";
      CONFLUENCE_USERNAME = placeholder."MCP/CONFLUENCE_USERNAME";
      CONFLUENCE_API_TOKEN = placeholder."MCP/CONFLUENCE_API_TOKEN";
    };
    #kagi = uvxServerWithEnv "kagimcp" {
    #  KAGI_API_KEY = placeholder."MCP/KAGI_API_TOKEN";
    #  KAGI_SUMMARIZER_ENGINE = "cecil";
    #};
    # Information & Knowledge
    context7 = npxServer "@upstash/context7-mcp";
    # Web
    playwright = {
      command = lib.getExe pkgs.playwright-mcp;
      args = [
        "--cdp-endpoint=http://127.0.0.1:9222"
        # Automatically named outputs (action snapshots, console logs,
        # screenshots) would otherwise land in each session's working tree.
        "--output-dir=${userHome}/.cache/playwright-mcp"
      ];
    };
  };

  browseruseServer = {
    browseruse = {
      command = lib.getExe pkgs.browser-use;
      args = [
        "--mcp"
      ];
      env = {
        BROWSER_USE_DEBUG_LOG_FILE = "/tmp/browser.log";
        ANONYMIZED_TELEMETRY = "False";
        BROWSER_USE_CONFIG_PATH = browseruse-conf;
        BROWSER_USE_LOGGING_LEVEL = "info";
        MODEL_PROVIDER = config.mine.ai-sandbox.browseruse.provider;
        OPENCODE_MODEL = config.mine.ai-sandbox.browseruse.opencode.model;
        OPENCODE_PROVIDER = config.mine.ai-sandbox.browseruse.opencode.provider;
        OPENCODE_BASE_URL = "http://127.0.0.1:4097";
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      };
    };
  };

  ghidraServer = {
    ghidra = {
      command = lib.getExe' pkgs.uv "uvx";
      args = [
        "pyghidra-mcp"
        "--project-path"
        "${userHome}/ghidra-projects"
      ];
      env = {
        GHIDRA_INSTALL_DIR = "${pkgs.ghidra}/lib/ghidra";
        JAVA_HOME = "${pkgs.jdk21.home}";
        # JPype's uv-installed native extension is not Nix-patched and needs
        # the C++ runtime available at load time.
        LD_LIBRARY_PATH = lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
      };
    };
  };

  servers =
    builtInServers
    // lib.optionalAttrs config.mine.ai-sandbox.browseruse.enable browseruseServer
    // lib.optionalAttrs config.mine.ai-sandbox.ghidra.enable ghidraServer
    // config.mine.ai-sandbox.extraServers;

  extraServerNames = lib.subtractLists defaultServerOrder (builtins.attrNames servers);
  serverOrder = defaultServerOrder ++ extraServerNames;

  # Process servers also get the telemetry opt-outs: the MCP launcher does not
  # pass the service environment on. A server's own variables win.
  mkTemplate = name: serverConfig: {
    name = "mcp-${name}";
    value = {
      content = builtins.toJSON {
        mcpServers.${name} =
          if serverConfig ? command then
            serverConfig // { env = telemetryOptOut // (serverConfig.env or { }); }
          else
            serverConfig;
      };
      owner = config.variables.username;
    };
  };

  # Canonical port assignment: the single source of truth for server → port.
  serverPorts = lib.listToAttrs (lib.imap0 (i: name: lib.nameValuePair name (8000 + i)) serverOrder);

  # URLs for only the built-in (default) servers.
  defaultServerUrls = lib.listToAttrs (
    map (
      name: lib.nameValuePair name "http://127.0.0.1:${toString serverPorts.${name}}/${name}"
    ) defaultServerOrder
  );

  # Serialized extra config for the automation opencode instance.
  automationConfigJson = builtins.toJSON automationConfig;
  automationEnv =
    if automationConfig != { } then
      "OPENCODE_CONFIG_CONTENT=${lib.escapeShellArg automationConfigJson} "
    else
      "";

  # Prebuilt native modules of npm plugins (opencode-mem's ONNX runtime and
  # libSQL bindings) need the C++ runtime, which NixOS has no default path for.
  nativeLibs = "LD_LIBRARY_PATH=${
    lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
  }\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} ";
in
{
  templates = builtins.listToAttrs (lib.mapAttrsToList mkTemplate servers);

  loadConfig = lib.mapAttrsToList (
    name: _: "config_${name}.json:${config.sops.templates."mcp-${name}".path}"
  ) servers;

  # All server URLs (built-in + extra). Exposed as mine.ai-sandbox.serverUrls.
  serverUrls = lib.mapAttrs (name: port: "http://127.0.0.1:${toString port}/${name}") serverPorts;

  # Only built-in server URLs, passed to the home-manager opencode module.
  inherit defaultServerUrls passwordFile;

  execStartScript = pkgs.writeShellScript "ai-sandbox-server" ''
    mkdir -p ~/workspace
    cd ~/workspace
    if [ ! -s ${passwordFile} ]; then
      (umask 077 && head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' >${passwordFile})
    fi
    OPENCODE_PASSWORD="$(cat ${passwordFile})"
    export OPENCODE_PASSWORD
    ${proxyPrefix}${nativeLibs}OPENCODE_DB=opencode-stable.db ${opencode} serve --hostname 127.0.0.1 --port 4096 & # --print-logs
    ${proxyPrefix}${automationEnv}OPENCODE_DB=opencode-automation.db ${opencode} serve --hostname 127.0.0.1 --port 4097 & # --print-logs
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        name: port:
        "${fastmcpCli} run $CREDENTIALS_DIRECTORY/config_${name}.json --no-banner -t streamable-http -p ${toString port} --path /${name} &"
      ) serverPorts
    )}
    wait
  '';
}
