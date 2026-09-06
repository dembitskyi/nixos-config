# Default model definitions for vLLM.
# Users can extend this set via mine.vllm.models.
{ pkgs }:
let
  # Shared base for the two Qwen3.8-Flash-Next NVFP4 variants below (native
  # 256K and the long-context 850K one): one 96GB card (TP=1), 51B PLE n-gram
  # table offloaded to host RAM, digest-pinned image so the overlays stay
  # line-exact.
  flashNextOverlayDir = ./overlays/qwen3.8-flash-next-nvfp4;
  flashNextOverlay = src: dst: "${flashNextOverlayDir}/${src}:${dst}:ro";
  # Common vLLM args; smaller batchedTokens = less activation = more KV headroom.
  flashNextArgs = batchedTokens: [
    "--trust-remote-code"
    "--tensor-parallel-size"
    "1"
    "--distributed-executor-backend"
    "mp"
    "--max-num-batched-tokens"
    (toString batchedTokens)
    "--enable-prefix-caching"
    "--enable-prompt-tokens-details"
    "--no-enable-flashinfer-autotune"
    "--default-chat-template-kwargs ${
      pkgs.lib.escapeShellArg (builtins.toJSON { reasoning_effort = "medium"; })
    }"
  ];

  # YaRN rope scaling to extend the native 262144 window by `factor`.
  flashNextYarn =
    factor:
    "--hf-overrides ${
      pkgs.lib.escapeShellArg (
        builtins.toJSON {
          rope_scaling = {
            rope_type = "yarn";
            inherit factor;
            original_max_position_embeddings = 262144;
          };
        }
      )
    }";

  # fp8_e4m3 / nvfp4 KV cache on the QSA attention path (vLLM PR #54846),
  # generated from andreasgru's kvq-patch.py against the pinned image; lifts the
  # QSA kernel's BF16-only KV guard. Only used by the variant that sets
  # --kv-cache-dtype.
  flashNextKvqPatches =
    let
      kvq = sub: patch: {
        target = "/usr/local/lib/python3.12/dist-packages/vllm/${sub}";
        inherit patch;
      };
    in
    [
      (kvq "models/qwen3_8_flash_next/nvidia/qsa.py" ./overlays/qwen3.8-flash-next-nvfp4/qsa.py.patch)
      (kvq "models/qwen3_8_flash_next/nvidia/ops/qsa.py" ./overlays/qwen3.8-flash-next-nvfp4/ops-qsa.py.patch)
      (kvq "platforms/interface.py" ./overlays/qwen3.8-flash-next-nvfp4/interface.py.patch)
    ];

  flashNextBase = {
    huggingfaceId = "nvidia/Qwen3.8-Flash-Next-NVFP4";
    servedName = "Qwen3.8-Flash-Next-NVFP4";
    # Digest of vllm/vllm-openai:qwen38-flash-next = vLLM 0.1.dev20073+g8e685d198.
    image = "vllm/vllm-openai@sha256:fc120ece0a388cc0aa1caad4a9f1cd92113484ab7ec2fd0efadd62585be05bf8";
    quantization = "modelopt";
    maxModelLen = 262144;
    maxNumSeqs = 2;
    gpuMemoryUtilization = 0.94;
    toolCallParser = "qwen3_xml";
    reasoningParser = "qwen3";
    # MTP speculative decoding; relies on the mtp.py + modelopt.py overlays
    # below (vLLM #55496, PR #55513).
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 3;
    };
    extraEnv = {
      VLLM_PLE_CPU_OFFLOAD = "1";
      VLLM_PLE_FP8_CHECKPOINT = "1";
      VLLM_PLE_OFFLOAD_READY_TIMEOUT = "1800";
      TORCH_CUDA_ARCH_LIST = "12.0f";
      PYTORCH_ALLOC_CONF = "expandable_segments:True";
    };
    # SYS_PTRACE: torch CUDA IPC (pidfd_getfd) for PLE offload — also needs
    # host kernel.yama.ptrace_scope=0. SYS_NICE/seccomp: defensive.
    extraDockerArgs = [
      "--cap-add SYS_PTRACE"
      "--cap-add SYS_NICE"
      "--security-opt seccomp=unconfined"
    ];
    # connector.py: fixes the PLE-offload warmup deadlock (model stream
    # parks on cuStreamWaitValue vs the connector's _input_ready_event).
    # vLLM PLE offload: #53899.
    extraMounts = [
      (flashNextOverlay "connector.py" "/usr/local/lib/python3.12/dist-packages/vllm/v1/ple_offload/connector.py")
    ];
    # Per-file diffs over the pinned image's own copies.
    imagePatches = [
      {
        # Force the FP8 PLE embedding for this mixed NVFP4+FP8 checkpoint.
        target = "/usr/local/lib/python3.12/dist-packages/vllm/models/qwen3_8_flash_next/nvidia/ple_layer.py";
        patch = ./overlays/qwen3.8-flash-next-nvfp4/ple_layer.py.patch;
      }
      # MTP FP8_PB_WO/BLOCK_SCALES experts (vLLM #55496, PR #55513): mtp.py
      # remaps the draft's quantized_layers index, modelopt.py routes those
      # experts to block-FP8. Fixes "has no parameter 'w2_weight_scale_inv'".
      {
        target = "/usr/local/lib/python3.12/dist-packages/vllm/models/qwen3_8_flash_next/nvidia/mtp.py";
        patch = ./overlays/qwen3.8-flash-next-nvfp4/mtp.py.patch;
      }
      {
        target = "/usr/local/lib/python3.12/dist-packages/vllm/model_executor/layers/quantization/modelopt.py";
        patch = ./overlays/qwen3.8-flash-next-nvfp4/modelopt.py.patch;
      }
    ];
    extraArgs = flashNextArgs 8192;
  };
in
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

  "qwen3.8-27b-nvfp4" = {
    huggingfaceId = "unsloth/Qwen3.8-27B-NVFP4";
    servedName = "Qwen3.8-27B-NVFP4";
    # NVFP4 on Blackwell needs a CUDA 13 build. vLLM ships no versioned
    # v0.25.x-cu130 release tag; cu130 support for this model rides in the
    # model-specific image.
    image = "vllm/vllm-openai:qwen38-x86_64-cu130";
    quantization = null;
    maxModelLen = 262144;
    maxNumSeqs = 64;
    gpuMemoryUtilization = 0.80;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 3;
    };
    # Pin the default reasoning effort to xhigh (also the checkpoint's chat
    # template default). Clients can override per-request via chat_template_kwargs.
    extraArgs = [
      "--default-chat-template-kwargs ${
        pkgs.lib.escapeShellArg (builtins.toJSON { reasoning_effort = "xhigh"; })
      }"
    ];
  };

  # Official Qwen3.8-27B (BF16), two profiles from one checkpoint: full
  # multimodal below, and a text-only variant (--language-model-only) to save VRAM.
  "qwen3.8-27b" = {
    huggingfaceId = "Qwen/Qwen3.8-27B";
    servedName = "Qwen3.8-27B";
    image = "vllm/vllm-openai:qwen38-x86_64-cu130";
    quantization = null;
    maxModelLen = 262144;
    maxNumSeqs = 8;
    gpuMemoryUtilization = 0.90;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 3;
    };
    # Default reasoning effort medium (override per-request via chat_template_kwargs).
    extraArgs = [
      "--default-chat-template-kwargs ${
        pkgs.lib.escapeShellArg (builtins.toJSON { reasoning_effort = "medium"; })
      }"
    ];
  };

  # Text-only profile of Qwen3.8-27B (vision tower dropped).
  "qwen3.8-27b-text" = {
    huggingfaceId = "Qwen/Qwen3.8-27B";
    servedName = "Qwen3.8-27B-text";
    image = "vllm/vllm-openai:qwen38-x86_64-cu130";
    quantization = null;
    maxModelLen = 262144;
    maxNumSeqs = 16;
    gpuMemoryUtilization = 0.90;
    toolCallParser = "qwen3_coder";
    reasoningParser = "qwen3";
    speculativeConfig = {
      method = "mtp";
      num_speculative_tokens = 3;
    };
    extraArgs = [
      "--language-model-only"
      "--default-chat-template-kwargs ${
        pkgs.lib.escapeShellArg (builtins.toJSON { reasoning_effort = "medium"; })
      }"
    ];
  };

  # NVIDIA Qwen3.6-35B-A3B: official mixed NVFP4/FP8 ModelOpt checkpoint.
  # Quantization is auto-detected from hf_quant_config.json (no explicit
  # --quantization needed); vision stays multimodal.
  "qwen3.6-35b-a3b" = {
    huggingfaceId = "nvidia/Qwen3.6-35B-A3B-NVFP4";
    servedName = "Qwen3.6-35B-A3B";
    # v0.24.0-ubuntu2404, pinned by digest for a reproducible vLLM runtime.
    image = "vllm/vllm-openai@sha256:bfdefe75b5c3fb83f4f0fcaae8f39fac87941cbadb05cd2203f44a1689236c71";
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
      "--moe-backend"
      "marlin"
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

  "qwen3.8-flash-next-nvfp4" = flashNextBase;

  "qwen3.8-flash-next-nvfp4-850k" = flashNextBase // {
    servedName = "Qwen3.8-Flash-Next-NVFP4-850K";
    # YaRN 262144 -> 870400 (factor 3.3203125). fp8 KV (QSA patch below) at
    # util 0.98 sits right at the fp8 ceiling on this 96GB card; batched 2048
    # buys the activation headroom to fit. fp8 KV + MTP is untested upstream.
    maxModelLen = 870400;
    gpuMemoryUtilization = 0.98;
    speculativeConfig = flashNextBase.speculativeConfig // {
      num_speculative_tokens = 4;
    };
    extraEnv = flashNextBase.extraEnv // {
      VLLM_ALLOW_LONG_MAX_MODEL_LEN = "1";
      QFN_KVQ_NVFP4_WRITER = "native";
      QFN_KVQ_V_SF_SWIZZLED = "1";
      QFN_KVQ_SF_MODE = "2";
    };
    imagePatches = flashNextBase.imagePatches ++ flashNextKvqPatches;
    extraArgs = flashNextArgs 2048 ++ [
      (flashNextYarn 3.3203125)
      "--kv-cache-dtype"
      "fp8_e4m3"
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
