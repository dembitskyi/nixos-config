# Default model definitions for vLLM.
# Users can extend this set via mine.vllm.models.
{ pkgs }:
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

  # NVIDIA Nemotron-3-Super: 120B-A12B hybrid Mamba-2/MoE, NVFP4.
  # Needs vLLM 0.20.0 + the custom `super_v3` reasoning-parser plugin.
  "nemotron-3-super" = {
    huggingfaceId = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4";
    servedName = "Nemotron-3-Super-120B";
    # NVFP4 is auto-detected from the checkpoint's hf_quant_config.json when
    # --dtype auto is passed, so no explicit --quantization is needed.
    quantization = null;
    maxModelLen = 262144;
    maxNumSeqs = 2;
    gpuMemoryUtilization = 0.85;
    toolCallParser = "qwen3_coder";
    reasoningParser = "super_v3";
    reasoningParserPlugin = pkgs.fetchurl {
      name = "super_v3_reasoning_parser.py";
      url = "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4/raw/main/super_v3_reasoning_parser.py";
      hash = "sha256-9/xx0Wl+15kxeHz3SF7ilzZaQcNELMHgXm66tD4KOcE=";
    };
    image = "vllm/vllm-openai:v0.20.0";
    # MTP (multi-token prediction) speculative decoding for throughput. If it
    # errors on the FP4 MoE path, add moe_backend = "triton" (NVIDIA's Nemotron
    # reference), or set to null to disable.
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 3;
    };
    extraArgs = [
      "--dtype"
      "auto"
      "--async-scheduling"
      "--kv-cache-dtype"
      "fp8"
      "--max-cudagraph-capture-size"
      "128"
      "--enable-chunked-prefill"
      "--mamba-ssm-cache-dtype"
      "float16"
      "--trust-remote-code"
    ];
  };

  # NVIDIA Qwen3.5-122B: 122B-A10B multimodal (text/image/video) MoE, NVFP4.
  # Full-attention → KV-heavy; maxModelLen is VRAM-bound.
  "qwen3.5-122b-nvfp4" = {
    huggingfaceId = "nvidia/Qwen3.5-122B-A10B-NVFP4";
    servedName = "Qwen3.5-122B-NVFP4";
    quantization = "modelopt_fp4";
    maxModelLen = 200000;
    maxNumSeqs = 1;
    gpuMemoryUtilization = 0.96;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = null;
    extraArgs = [
      "--kv-cache-dtype"
      "fp8"
      "--moe-backend"
      "marlin"
      "--trust-remote-code"
    ];
  };

  # OpenAI gpt-oss-120b: MXFP4 MoE + NVIDIA Eagle3 speculative draft.
  "gpt-oss-120b" = {
    huggingfaceId = "openai/gpt-oss-120b";
    servedName = "gpt-oss-120b";
    quantization = "mxfp4";
    maxModelLen = 131072;
    maxNumSeqs = 2;
    gpuMemoryUtilization = 0.85;
    toolCallParser = "openai";
    reasoningParser = "openai_gptoss";
    speculativeConfig = {
      method = "eagle3";
      model = "nvidia/gpt-oss-120b-Eagle3-v3";
      num_speculative_tokens = 7;
    };
    extraArgs = [ ];
  };

  # Multiverse Hypernova-60B: gpt-oss-arch (harmony format) MoE, MXFP4.
  "hypernova-60b" = {
    huggingfaceId = "MultiverseComputingCAI/Hypernova-60B-2605";
    servedName = "Hypernova-60B";
    quantization = "mxfp4";
    maxModelLen = 131072;
    maxNumSeqs = 2;
    gpuMemoryUtilization = 0.85;
    toolCallParser = "openai";
    reasoningParser = "openai_gptoss";
    speculativeConfig = null;
    extraArgs = [ ];
  };
}
