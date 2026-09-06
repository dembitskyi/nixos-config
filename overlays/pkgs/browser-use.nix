{ pkgs, ... }:
let
  # Defined in a let-block so inline derivations can reference each other
  # (e.g. bubus → uuid7). Once these land in nixpkgs, remove them from here
  # and drop the corresponding entries from the callPackage override set below.

  uuid7 = pkgs.python3Packages.buildPythonPackage rec {
    pname = "uuid7";
    version = "0.1.0";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      inherit pname version;
      hash = "sha256-jFeqMu50VtPMaMlcRTC8VxZG3vrAGJXPxzVFRJiUpjw=";
    };
    build-system = [ pkgs.python3Packages.setuptools ];
  };

  pyotp = pkgs.python3Packages.buildPythonPackage rec {
    pname = "pyotp";
    version = "2.9.0";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      inherit pname version;
      hash = "sha256-NGtmQuDb3eO0/1qTC2ZMqCq/oRY1btSMxCx9ZZDTb2M=";
    };
    build-system = [ pkgs.python3Packages.setuptools ];
  };

  screeninfo = pkgs.python3Packages.buildPythonPackage rec {
    pname = "screeninfo";
    version = "0.8.1";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      inherit pname version;
      hash = "sha256-mYMHa8x+NEAqGp5NfavzcpQR/Sq7PztL5+unNRnNLtE=";
    };
    build-system = [ pkgs.python3Packages.poetry-core ];
  };

  inquirerpy = pkgs.python3Packages.buildPythonPackage rec {
    pname = "InquirerPy";
    version = "0.3.4";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      inherit pname version;
      hash = "sha256-idKtoBEfM3SDy0GuMQcxCLLsHmGKSdcRCw163on8GX4=";
    };
    build-system = [ pkgs.python3Packages.poetry-core ];
    propagatedBuildInputs = with pkgs.python3Packages; [
      pfzy
      prompt-toolkit
    ];
  };

  google-genai = pkgs.python3Packages.buildPythonPackage rec {
    pname = "google-genai";
    version = "1.65.0";
    # No sdist on PyPI — install directly from wheel
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/py3/g/google_genai/google_genai-1.65.0-py3-none-any.whl";
      hash = "sha256-aMAlIFhWkZvAPtsBVcEbS4M4ELfOF61Lep7rpRWPbEQ=";
    };
    format = "wheel";
    propagatedBuildInputs = with pkgs.python3Packages; [
      google-auth
      httpx
      pydantic
      requests
      typing-extensions
      websockets
      tenacity
      distro
      sniffio
    ];
  };

  cdp-use = pkgs.python3Packages.buildPythonPackage rec {
    pname = "cdp-use";
    version = "1.4.5";
    # No sdist on PyPI — install directly from wheel
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/py3/c/cdp_use/cdp_use-1.4.5-py3-none-any.whl";
      hash = "sha256-j44kNeOiDkAJ0pdBRBks88Ey9sKXEzjhVhmIFNm5Hss=";
    };
    format = "wheel";
    propagatedBuildInputs = with pkgs.python3Packages; [
      httpx
      typing-extensions
      websockets
    ];

  };

  bubus = pkgs.python3Packages.buildPythonPackage rec {
    pname = "bubus";
    version = "1.5.6";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      inherit pname version;
      hash = "sha256-GlRW8KV26GYTp71m6BmJG2d3eDILbikQlOM5sNnfLg0=";
    };
    build-system = [ pkgs.python3Packages.hatchling ];
    propagatedBuildInputs =
      (with pkgs.python3Packages; [
        aiofiles
        anyio
        portalocker
        pydantic
      ])
      ++ [ uuid7 ]; # uuid7 visible here because it's in the same let-block
  };

  opencode-ai = pkgs.python3Packages.buildPythonPackage rec {
    pname = "opencode-ai";
    version = "0.1.0a36";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      pname = "opencode_ai";
      inherit version;
      hash = "sha256-PNiehuSjM/UpmfwN8zevyb45KYx1XhokHXfdM9fXkFA=";
    };
    build-system = with pkgs.python3Packages; [
      hatchling
      hatch-fancy-pypi-readme
    ];
    postPatch = ''
      sed -i 's/hatchling==1.26.3/hatchling/' pyproject.toml
    '';
    propagatedBuildInputs = with pkgs.python3Packages; [
      httpx
      pydantic
      typing-extensions
      anyio
      distro
      sniffio
    ];
  };

  browser-use-sdk = pkgs.python3Packages.buildPythonPackage rec {
    pname = "browser-use-sdk";
    version = "3.4.2";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      pname = "browser_use_sdk";
      inherit version;
      hash = "sha256-vgULyAOzHsTp8j39cdncXxFg197AuWIyeRXK90OhAgg=";
    };
    # 3.4.x builds with hatchling (the 2.0.x line used poetry-core).
    build-system = [ pkgs.python3Packages.hatchling ];
    propagatedBuildInputs = with pkgs.python3Packages; [
      httpx
      pydantic
      typing-extensions
    ];
  };

  fetch-use = pkgs.python3Packages.buildPythonPackage rec {
    pname = "fetch-use";
    version = "0.4.0";
    # Required by browser-harness; zero runtime dependencies of its own.
    # No sdist build needed — install directly from wheel.
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/57/97/d4104692aa5c99a30fea22b5adffd2ce35b1ad86ae5236766cfc1ae468f1/fetch_use-0.4.0-py3-none-any.whl";
      hash = "sha256-t4hfKQfnkgNz+nXc2wCv1uYDolqe4hUaoogfVGXhosA=";
    };
    format = "wheel";
  };

  browser-harness = pkgs.python3Packages.buildPythonPackage rec {
    pname = "browser-harness";
    version = "0.1.13";
    # Vendored into browser-use 0.13+; only imported by the interactive CLI
    # path, never by `--mcp`. Installed from wheel.
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/4a/bd/f166cf9a465eff436048d25851ab28b0d798af02b56998127a4165227fc4/browser_harness-0.1.13-py3-none-any.whl";
      hash = "sha256-JJFFnkv8Duiuoi3GxGgPwPeRt7pVNEYyPFDSiDRJ12k=";
    };
    format = "wheel";
    propagatedBuildInputs =
      with pkgs.python3Packages;
      [
        cdp-use
        pillow
        websockets
      ]
      ++ [ fetch-use ]; # from the same let-block

    # The wheel METADATA pins exact versions (e.g. websockets==15.0.1);
    # nixpkgs carries newer ones. The real runtime deps are provided via
    # propagatedBuildInputs above, so skip the literal wheel metadata check.
    dontCheckRuntimeDeps = true;
  };

  # browser-use 0.13's MCP server needs the mcp 2.x lowlevel API
  # (Server.add_request_handler); nixpkgs only carries 1.29. The 2.x line
  # lives under new PyPI names (httpx2/httpcore2, mcp-types). Pure-Python
  # wheels, installed with nixpkgs-provided deps.
  mcp-types = pkgs.python3Packages.buildPythonPackage rec {
    pname = "mcp-types";
    version = "2.1.1";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/71/d0/242e63c510f4a17381f55b1549a3f94f5687a0595984febd2b6f87a687a0/mcp_types-2.1.1-py3-none-any.whl";
      hash = "sha256-Jvn38D8qVzBxeluY4qt+tkCsNS0FoAzcclwxGGR3gpU=";
    };
    format = "wheel";
    propagatedBuildInputs = with pkgs.python3Packages; [
      pydantic
      typing-extensions
    ];
    dontCheckRuntimeDeps = true;
  };

  httpcore2 = pkgs.python3Packages.buildPythonPackage rec {
    pname = "httpcore2";
    version = "2.5.0";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/c9/a1/7564199d1a8728fe737b0a72e5b3f8d92dfe085a74ddf7cdd83bce5f206d/httpcore2-2.5.0-py3-none-any.whl";
      hash = "sha256-XONRiN5GHTHo0AC/uO+L8ixsFlh6IR5Vcd6qXpvfhCo=";
    };
    format = "wheel";
    propagatedBuildInputs = with pkgs.python3Packages; [
      h11
      truststore
    ];
    dontCheckRuntimeDeps = true;
  };

  httpx2 = pkgs.python3Packages.buildPythonPackage rec {
    pname = "httpx2";
    version = "2.5.0";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/31/22/859d8252dad9bc9adee34b52e62cde621ece07b042ccb2ab4da1be46695f/httpx2-2.5.0-py3-none-any.whl";
      hash = "sha256-PS1NnPS2HxofRqlZR8/bR+gMtWovkcYlasj1jkiR30E=";
    };
    format = "wheel";
    propagatedBuildInputs =
      with pkgs.python3Packages;
      [
        anyio
        idna
        truststore
        typing-extensions
      ]
      ++ [ httpcore2 ]; # from the same let-block
    dontCheckRuntimeDeps = true;
  };

  mcp = pkgs.python3Packages.buildPythonPackage rec {
    pname = "mcp";
    version = "2.1.1";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/50/af/8644cc5fa26a59afd2df2e98eeb19e72926887fa4b7441aba4ff661140db/mcp-2.1.1-py3-none-any.whl";
      hash = "sha256-HGwxxdZHHFjbdq86+K9n9G0R0B8KWQd9CjCMvbPT6RU=";
    };
    format = "wheel";
    propagatedBuildInputs =
      with pkgs.python3Packages;
      [
        anyio
        jsonschema
        opentelemetry-api
        pydantic
        pyjwt
        cryptography # pyjwt[crypto]
        python-multipart
        sse-starlette
        starlette
        typing-extensions
        typing-inspection
        uvicorn
      ]
      ++ [
        httpx2
        mcp-types
      ]; # from the same let-block
    dontCheckRuntimeDeps = true;
  };
in
pkgs.python3Packages.callPackage
  (
    {
      lib,
      fetchFromGitHub,
      nix-update-script,
      buildPythonApplication,
      hatchling,
      # core deps already in nixpkgs
      aiofiles,

      aiohttp,
      anthropic,
      anyio,
      beautifulsoup4,
      click,
      cloudpickle,
      google-api-python-client,
      google-auth,
      google-auth-oauthlib,
      groq,
      httpx,
      markdownify,
      mcp,
      ollama,
      openai,
      pillow,
      portalocker,
      psutil,
      pydantic,
      pydantic-settings,
      pypdf,
      python-docx,
      python-dotenv,
      reportlab,
      requests,
      rich,
      setuptools,
      typing-extensions,
      playwright,
      # deps from the let-block above
      bubus,
      cdp-use,
      browser-use-sdk,
      browser-harness,
      fetch-use,
      inquirerpy,
      screeninfo,
      uuid7,
      pyotp,
      google-genai,
      # dev extras
      pytest,
      pytest-asyncio,
      opencode-ai,
    }:
    buildPythonApplication rec {
      pname = "browser-use";
      version = "0.1";
      pyproject = true;

      src = fetchFromGitHub {
        owner = "dembitskyi";
        repo = "browser-use";
        rev = "d6ed751904a80263ff7bd05b45fec5fefd2f277b";
        hash = "sha256-6BL2FaE0s/k0/PaxjpLU5R4Zw0sbB0CUw2xemnqdlI0=";
      };

      build-system = [ hatchling ];

      postPatch = ''
        # Strip all version constraints from pyproject.toml so that
        # nixpkgs-provided versions (which may be older or newer) are accepted.
        sed -i -E 's/hatchling==[0-9][0-9.]*/hatchling/' pyproject.toml
        sed -i -E 's/(anthropic)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(google-api-core)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(google-api-python-client)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(google-auth)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(mcp)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(openai)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(portalocker)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(psutil)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pydantic-core)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pydantic)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pydantic-settings)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pypdf)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(rich)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(groq)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pillow)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(reportlab)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(requests)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(aiohttp)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(anyio)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(ollama)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(python-dotenv)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(click)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(markdownify)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(typing-extensions)[^"]*"/\1"/g' pyproject.toml
      '';

      dependencies = [
        opencode-ai

        aiofiles
        aiohttp
        anthropic
        anyio
        beautifulsoup4
        browser-harness
        browser-use-sdk
        bubus
        cdp-use
        click
        cloudpickle
        google-api-python-client
        google-auth
        google-auth-oauthlib
        google-genai
        groq
        httpx
        fetch-use
        inquirerpy
        markdownify
        mcp
        ollama
        openai
        pillow
        portalocker
        psutil
        pydantic
        pydantic-settings
        pyotp
        pypdf
        python-docx
        python-dotenv
        reportlab
        requests
        rich
        screeninfo
        setuptools
        typing-extensions
        uuid7
        playwright
      ];

      optional-dependencies = {
        dev = [
          pytest
          pytest-asyncio
        ];
      };

      # Prevent playwright from downloading browsers at build time.
      # At runtime set: PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

      pythonImportsCheck = [ "browser_use" ];

      passthru.updateScript = nix-update-script {
        extraArgs = [
          "--flake"
          "--version=branch"
        ];
      };

      meta = {
        description = "Make websites accessible for AI agents";
        homepage = "https://github.com/dembitskyi/browser-use";
        changelog = "https://github.com/browser-use/browser-use/blob/${src.rev}/CHANGELOG.md";
        license = lib.licenses.mit;
        maintainers = [ ];
        mainProgram = "browser-use";
      };
    }
  )
  {
    # Thread the let-bound packages into callPackage's override set.
    inherit
      uuid7
      pyotp
      screeninfo
      inquirerpy
      google-genai
      cdp-use
      bubus
      browser-use-sdk
      browser-harness
      fetch-use
      mcp
      opencode-ai
      ;
  }
