{
  lib,
  fetchFromGitHub,
  buildPythonPackage,
  hatchling,
  pydantic,
  docling-core,
  pydantic-settings,
  filetype,
  requests,
  certifi,
  pluggy,
  tqdm,
  typer,
  rich,
  numpy,
  pillow,
  scipy,
  rtree,
  pypdfium2,
  python-docx,
  python-pptx,
  openpyxl,
  beautifulsoup4,
  lxml,
  marko,
  pylatexenc,
  polyfactory,
  torch,
  torchvision,
  docling-ibm-models,
  accelerate,
  huggingface-hub,
  defusedxml,
  httpx,
  websockets,
  typing-extensions,
  rapidocr,
  onnxruntime,
}:

# buildPythonPackage (not Application) so it is importable as a library while
# still installing the docling console script.
buildPythonPackage rec {
  pname = "docling";
  version = "2.93.0";
  pyproject = true;

  src = fetchFromGitHub {
    owner = "docling-project";
    repo = "docling";
    rev = "v${version}";
    hash = "sha256-bLDV4hZOmuYQqkBRU/bmGR9YmRqahj0RyTYeLttTuAs=";
  };

  # docling-parse is broken in nixpkgs (C++ build fails with nlohmann_json 3.12),
  # so swap the backend for a stub that falls back to pypdfium2.
  patches = [ ./disable-docling-parse.patch ];

  build-system = [ hatchling ];

  dependencies = [
    pydantic
    docling-core
    pydantic-settings
    filetype
    requests
    certifi
    pluggy
    tqdm
    typer
    rich
    numpy
    pillow
    scipy
    rtree
    pypdfium2
    python-docx
    python-pptx
    openpyxl
    beautifulsoup4
    lxml
    marko
    pylatexenc
    polyfactory
    torch
    torchvision
    docling-ibm-models
    accelerate
    huggingface-hub
    defusedxml
    httpx
    websockets
    typing-extensions
    rapidocr
    onnxruntime
  ];

  # Many transitive deps may not be in nixpkgs; skip strict runtime dep checking.
  dontCheckRuntimeDeps = true;

  # Tests require network access and model downloads.
  doCheck = false;

  pythonImportsCheck = [ "docling" ];

  meta = {
    description = "SDK and CLI for parsing PDF, DOCX, HTML, and more to a unified document representation";
    homepage = "https://github.com/docling-project/docling";
    license = lib.licenses.mit;
    mainProgram = "docling";
    platforms = lib.platforms.unix;
  };
}
