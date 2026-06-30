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
    gpuMemoryUtilization = 0.85;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = null;
    extraArgs = [
      "--kv-cache-dtype"
      "fp8_e4m3"
      "--trust-remote-code"
      # Multimodal: run vision encoder data-parallel and use shared-mem image cache.
      "--mm-encoder-tp-mode"
      "data"
      "--mm-processor-cache-type"
      "shm"
    ];
  };

  # Small vision model; runs resident alongside the swapped chat models, so it
  # must fit in the GPU memory they leave free (fraction is of total VRAM).
  "granite-docling" = {
    huggingfaceId = "ibm-granite/granite-docling-258M";
    servedName = "granite-docling";
    quantization = null;
    maxModelLen = 8192;
    maxNumSeqs = 16;
    gpuMemoryUtilization = 0.025;
    toolCallParser = null;
    reasoningParser = null;
    speculativeConfig = null;
    extraArgs = [
      "--enable-chunked-prefill"
      "--max-num-batched-tokens"
      "2048"
    ];
  };
}
