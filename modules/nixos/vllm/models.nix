# Default model definitions for vLLM.
# Users can extend this set via mine.vllm.models.
{
  "qwen3.5-27b-nvfp4" = {
    huggingfaceId = "osoleve/Qwen3.5-27B-NVFP4-MTP";
    servedName = "Qwen3.5-27B-NVFP4";
    quantization = "modelopt";
    maxModelLen = 200000;
    maxNumSeqs = 64;
    gpuMemoryUtilization = 0.80;
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
    gpuMemoryUtilization = 0.80;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = null;
    extraArgs = [
      "--kv-cache-dtype"
      "fp8_e4m3"
      "--trust-remote-code"
    ];
  };

  "qwen2.5-vl-7b" = {
    huggingfaceId = "Qwen/Qwen2.5-VL-7B-Instruct-AWQ";
    servedName = "Qwen2.5-VL-7B";
    quantization = null;
    maxModelLen = 32768;
    maxNumSeqs = 16;
    gpuMemoryUtilization = 0.15;
    toolCallParser = null;
    reasoningParser = null;
    speculativeConfig = null;
    extraArgs = [
      "--trust-remote-code"
      "--limit-mm-per-prompt '{\"image\":5}'"
    ];
  };
}