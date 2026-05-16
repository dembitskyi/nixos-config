{
  lib,
  config,
  ...
}:
{

  options = {
    mine.home.ollama.enable = lib.mkEnableOption "enable ollama (home part)";
  };

  config = lib.mkIf config.mine.home.ollama.enable {
    home.file.".ollama/models/llama3.1-just-chat.Modelfile".text = ''
      FROM llama3.1:70b
      TEMPLATE """{{ if .System }}<|im_start|>{{ .System }}<|im_end|>{{ end }}{{ if $.Tools }}[TOOLS IGNORED]{{"{"}}{{"}"}}[/TOOLS]{{ end }}{{ .Prompt }}<|eot_id|><|start_header_id|>assistant<|end_header_id|>"""
      PARAMETER stop <|start_header_id|>
      PARAMETER stop <|end_header_id|>
      PARAMETER stop <|eot_id|>
    '';
  };
}
