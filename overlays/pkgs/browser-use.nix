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
    version = "2.0.15";
    pyproject = true;
    src = pkgs.python3Packages.fetchPypi {
      pname = "browser_use_sdk";
      inherit version;
      hash = "sha256-CDKuCZhzbmOGRX5s9Qbigg2w1ibE2dvw9WfqK2xoiNM=";
    };
    build-system = [ pkgs.python3Packages.poetry-core ];
    propagatedBuildInputs = with pkgs.python3Packages; [
      httpx
      pydantic
      pydantic-core
      typing-extensions
    ];
  };
in
pkgs.python3Packages.callPackage
  (
    {
      lib,
      pkgs,
      fetchFromGitHub,
      nix-update-script,
      buildPythonApplication,
      hatchling,
      # core deps already in nixpkgs
      aiofiles,
      aiohttp,
      anthropic,
      anyio,
      authlib,
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
      posthog,
      psutil,
      pydantic,
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
        rev = "89cb30f5b7d805621a94528d190049df61f6c7c8";
        hash = "sha256-q0idD6o48d+fb/3ONm5puT+M7HbsfybzYBRa7JBFAy8=";
      };

      build-system = [ hatchling ];

      postPatch = ''
        # Strip all version constraints from pyproject.toml so that
        # nixpkgs-provided versions (which may be older or newer) are accepted.
        sed -i -E 's/(authlib)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(anthropic)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(google-api-core)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(google-api-python-client)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(google-auth)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(openai)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(portalocker)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(posthog)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(psutil)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pydantic-core)[^"]*"/\1"/g' pyproject.toml
        sed -i -E 's/(pydantic)[^"]*"/\1"/g' pyproject.toml
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
      '';

      dependencies = [
        opencode-ai
        aiofiles
        aiohttp
        anthropic
        anyio
        authlib
        beautifulsoup4
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
        inquirerpy
        markdownify
        mcp
        ollama
        openai
        pillow
        portalocker
        posthog
        psutil
        pydantic
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
      opencode-ai
      ;
  }
