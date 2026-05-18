# Default model definitions for vLLM.
# Users can extend this set via mine.vllm.models.
{
  "qwen3.5-27b-nvfp4" = {
    huggingfaceId = "osoleve/Qwen3.5-27B-NVFP4-MTP";
    servedName = "Qwen3.5-27B-NVFP4";
    quantization = "modelopt";
    maxModelLen = 128000;
    maxNumSeqs = 762;
    gpuMemoryUtilization = 0.70;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 1;
    };
    extraArgs = [ "--trust-remote-code" "--language-model-only" ];
  };

  "qwen3.6-35b-a3b-nvfp4" = {
    huggingfaceId = "RedHatAI/Qwen3.6-35B-A3B-NVFP4";
    servedName = "Qwen3.6-35B-A3B-NVFP4";
    quantization = null;
    maxModelLen = 32768;
    maxNumSeqs = 256;
    gpuMemoryUtilization = 0.90;
    toolCallParser = null;
    reasoningParser = "qwen3";
    speculativeConfig = null;
    extraArgs = [ ];
  };
}
