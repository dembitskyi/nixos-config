# Default model definitions for vLLM.
# Users can extend this set via mine.vllm.models.
{
  "qwen3.5-27b-nvfp4" = {
    huggingfaceId = "osoleve/Qwen3.5-27B-NVFP4-MTP";
    servedName = "Qwen3.5-27B-NVFP4";
    quantization = "modelopt";
    maxModelLen = 200000;
    maxNumSeqs = 64;
    gpuMemoryUtilization = 0.82;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 1;
    };
    extraArgs = [
      "--trust-remote-code"
      "--language-model-only"
    ];
  };

  "qwen3.6-35b-a3b" = {
    huggingfaceId = "Qwen/Qwen3.6-35B-A3B";
    servedName = "Qwen3.6-35B-A3B";
    quantization = null;
    maxModelLen = 200000;
    maxNumSeqs = 8;
    gpuMemoryUtilization = 0.82;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = null;
    extraArgs = [
      "--kv-cache-dtype"
      "fp8_e4m3"
      "--trust-remote-code"
    ];
  };
}
