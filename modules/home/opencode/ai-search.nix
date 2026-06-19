# AI web search over CDP, driving the persistent ai-browser on port 9222.
# Connects to the existing Chrome only (connect_over_cdp), so no browser
# download is needed — just the playwright Python package.
{
  writeShellApplication,
  python3,
}:
writeShellApplication {
  name = "ai-search";
  runtimeInputs = [ (python3.withPackages (ps: [ ps.playwright ])) ];
  text = ''
    exec python3 ${./scripts/ai-search.py} "$@"
  '';
}
