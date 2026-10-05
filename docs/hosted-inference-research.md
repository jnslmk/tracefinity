# Hosted inference for tool silhouette extraction

Research date: 2026-10-05. Initial desk research inspected repository integration and first-party model/API documentation. A subsequent three-photo Roboflow SAM 3 versus Gemini/OpenRouter trial is recorded below. Candidate prices are published USD rates/estimates unless explicitly identified as measured provider-reported cost; plan commitments, retries, repeated crop calls, and taxes can change total cost.

## Conclusion

There are credible hosted candidates beyond the default local models, but **no inspected source proves that one is more accurate on Tracefinity's tool photographs**. The small trial below found Gemini more complete on an assembled tool set and SAM 3 faster, without establishing fit accuracy. Further candidates to compare are:

1. **Existing fal BiRefNet at 2048 resolution**: smallest experiment, no new provider integration required. Evaluate trained 2K/Dynamic variants separately if the initial resolution comparison justifies it.
2. **fal SAM 3 image**: strongest new capability to investigate—text-directed multi-instance segmentation, plus point/box prompts. It could address selecting tools instead of the sheet, not merely improve background-removal edges. That potential is an inference, not a measured quality win.
3. **BRIA RMBG 2.0 and PhotoRoom**: useful commercial foreground-segmentation comparators at roughly two cents per image, rather than assuming another open-weight host improves the same model.
4. **Roboflow SAM 2/3**: particularly relevant if user clicks/negative clicks are acceptable for correcting difficult traces.

Do not replace the local defaults or add several adapters on marketing evidence alone. Keep offline local inference; benchmark these candidates before selecting one hosted quality option.

## Measured SAM 3 versus Gemini trial

On October 5, Roboflow `sam3/sam3_final` and OpenRouter `google/gemini-3.1-flash-image` were exercised on three unchanged corrected photos. Both received full-frame input and used Tracefinity's existing contour extraction. SAM 3 used the concept prompt `tool`, probability threshold 0.5, and decoded COCO RLE masks; Gemini used the production mask prompt. No local segmentation models were run.

| Photo | SAM 3 API round trip | Gemini API round trip | Observed silhouettes |
|---|---:|---:|---|
| Saw | 2.02 s | 10.89 s | Both retained the thin frame and its two openings. |
| Blue-lit tools | 2.29 s | 9.94 s | Both excluded the blue reference paper and outlined the tools well. Gemini also included the cream tube, reflecting its broader requested object scope. |
| Multi-tool | 2.07 s | 10.19 s | Both produced 14 final polygons, but full-frame SAM 3 selected only part of the hex-key set; Gemini included the full set and holder. Both merged the white case and adjacent lighter. |

Complete multi-tool tracing took 5.15 s for SAM 3 and 10.32 s for Gemini. API timings include network overhead; these single runs are not a controlled speed benchmark. OpenRouter reported a total cost of **$0.2050275** for the three fresh requests. Roboflow billed credit usage was not queried. There were no hand-labelled reference masks or verified print-fit tolerances.

SAM 3's paper-crop/growth diagnostic recovered the whole hex-key assembly but excluded several outer tools and required three requests. At threshold 0.5, the saw prompts `hacksaw` and `saw` returned no instances while `tool` worked; a full-frame `hex key set` prompt also returned no instances. Cropping and prompt choice therefore matter, and equal polygon counts do not establish equal completeness.

**Recommendation from this limited trial:** keep Gemini as the stronger default candidate for complete automatic whole-object extraction; treat SAM 3 as a credible faster alternative rather than a demonstrated universal replacement. SAM 3 returns native-input-coordinate masks; Gemini returned lower-resolution generated masks that the contour pipeline resized. Neither coordinate contract alone proves fit accuracy.

Local raw responses, masks, overlays, timings, and the updated HTML gallery remain in the intentionally gitignored `backend/storage/default/outputs/sam3-comparison-20261005/` and `backend/storage/default/outputs/trace-comparison-20261001/` directories. They are not distributed with this research note. Production provider configuration was not changed.

## What Tracefinity actually provides

“Recognition” here means **tool outlines/masks for fitted storage**, not classification or naming.

- Default local selection is `isnet`, `birefnet-lite`, `inspyrenet`; optional `birefnet-general` already offers full BiRefNet locally with GPU requirements. See [tracer registry](../backend/app/services/tracer_registry.py) and [tracing modes](../README.md#tracing-modes).
- Cloud support already exists: Gemini image-generated masks, Replicate `men1scus/birefnet`, and fal `fal-ai/birefnet/v2`. Default fal operating resolution is `1024x1024`. See [configuration](../backend/app/config.py).
- Local and remote saliency share paper cropping, including crop growth when masks touch a boundary. The remote adapter decodes alpha or grayscale, resizes to crop dimensions if necessary, thresholds at 127, and inserts the mask into original coordinates. Contour extraction subsequently performs morphology and area filtering, retaining interior rings. These steps affect the final outline independently of provider quality. See [tracing implementation](../backend/app/services/ai_tracer.py) and [remote adapter](../backend/app/services/remote_saliency.py).
- Tool naming is separate: local Ollama defaults to `qwen3-vl:4b`; hosted naming already supports OpenRouter or another image-capable OpenAI-compatible Chat Completions endpoint. A better naming VLM does not improve pocket geometry. See [tool naming](tool-naming.md).

Hosting identical weights improves hardware availability, not inherently accuracy. A quality comparison must name the checkpoint, processing resolution, and output conversion—not only the provider.

## Candidate comparison

| Candidate | Published cost | Relevant capability | Tracefinity fit / limitation |
|---|---|---|---|
| **fal BiRefNet v2** [1] | Not reliably established: provider's machine-readable page shows `$0 per compute seconds`; do not interpret this as a confirmed free service | Automatic masks; 1024, 2048, and Dynamic-only 2304 operating resolutions; several checkpoint choices | Already integrated. `FAL_OPERATING_RESOLUTION=2048x2048` changes resolution without code. Selecting a variant requires adding the request's `model` field; `FAL_MODEL` currently selects the endpoint, not the checkpoint. |
| **Replicate BiRefNet** [2] | Approximately **$0.0015/run**; about **$1.50/1,000** runs | Legacy general BiRefNet; provider says typical predictions finish within 2 seconds on A100 | Already integrated; low-cost hosted baseline, not evidence of a newer or stronger model. End-to-end latency not measured. |
| **fal SAM 3 image** [3] | **$0.005/request**; **$5/1,000** requests | Text, points, boxes; multiple mask images, scores, boxes | Promising new model capability. Needs distinct request/response handling: `masks[]`, optional `image`, prompts, mask selection; not a `FAL_MODEL`-only swap. Geometry/resolution must be checked. |
| **Roboflow SAM 2 / SAM 3** [4] | SAM 2 Tiny/Small **0.3125 credits/1,000 images**; SAM 2 Base+/Large and SAM 3 **0.5 credits/1,000** | Positive/negative clicks, boxes; polygon/RLE/binary mask formats; SAM 3 concept segmentation | Strong interactive-correction fit; new adapter and prompt workflow. Credits are not dollars: monetary cost depends on account/plan terms. Multiple prompt calls can increase cost. |
| **BRIA Remove Background / RMBG 2.0** [5] | **$0.018/image**; **$18/1,000** | Alpha cutout, explicit support for thresholding alpha into a binary mask | Different fine-tuned commercial candidate. New adapter: `image` base64/URL, `sync=true`, response `result.image_url`. Maximum resolution/retention not established from reviewed endpoint docs. |
| **PhotoRoom Basic Remove Background** [6] | **$0.02/image** advertised under Basic; pricing lists a **$20** plan | Grayscale mask via `channels=alpha`, or transparent cutout | New multipart-upload adapter. Mask-only skips matting and has less precise edges according to PhotoRoom: compare against thresholding cutout alpha, not just the smaller mask download. |
| **Pixelcut** [7] | **5 credits = $0.05/image**; **$50/1,000** | Transparent PNG, alpha mask or foreground/alpha ZIP; advertises up to 6000×6000 | Black-box comparator, but more expensive than the above; direct API needs another contract. No tool-boundary benchmark found. |
| **Replicate SAM 2** [8] | Approximately **$0.019/run**; about **$19/1,000** | Image-only hosted large SAM 2 variant | Provider says predictions typically complete within 20 seconds. Lower priority than fal SAM 3 / Roboflow for the initial trial; verify pinned schema before integration. |

Costs per 1,000 are simple arithmetic at the listed rate, assuming one request per photo. The existing crop-growth path can invoke inference more than once for a photo. Roboflow's local GPU timing figures are not hosted round-trip latency; the SAM 3/Gemini timings above are observed single runs, not a controlled cross-provider latency ranking.

### BiRefNet: resolution and checkpoint matter more than host

fal's inspected schema defaults `model` to **General Use (Light)**. It offers Light, Light 2K, Heavy, Matting, Portrait, and Dynamic. It describes Heavy as slower/more accurate, but also maps Light to `BiRefNet` and Heavy to `BiRefNet_lite`; those labels do **not** establish a reliable parameter-size ordering or equivalence to Tracefinity's local weights. Verify actual checkpoints rather than recommending “Heavy” by name. Light 2K maps to `BiRefNet_lite-2K`, not necessarily the upstream full HR model. [1]

Upstream **BiRefNet_HR** was trained at 2048². Its DIS-VD S-measure is **0.927 at 2048**, versus standard BiRefNet's **0.898 at 2048**. But at 1024 the HR model scores **0.893**, below standard BiRefNet's **0.912**. This supports evaluating matched training/inference resolution, not assuming that upscaling any checkpoint helps. These are general dataset results, not tool-photo results. [9]

Cloudflare reports BiRefNet-general mean IoU **0.87** versus IS-Net **0.82** across Humans/DIS5K, and chose BiRefNet for background removal. Its SAM comparison concerns the original SAM/unprompted foreground task, **not SAM 2 or SAM 3**. [10]

Tracefinity's previous five-image comparison used approximate Gemini-derived reference outlines: IS-Net's average IoU was **0.508**, full BiRefNet's **0.489**, while visual assessment favored BiRefNet's edges on reflective surfaces. The maintainer explicitly warns that these are relative, approximate scores. This is not evidence that full BiRefNet uniformly wins here, nor a reliable cloud-provider ranking. Current checked-out configuration, not that issue's historical default, defines today's baseline. [11]

### SAM 3: a genuinely different selection mechanism

Meta documents SAM 3 as segmenting all instances of an open-vocabulary concept from short text or exemplars, in addition to visual prompts. That is materially different from saliency's “what stands out?” objective. **Inference:** prompting for tools could avoid choosing reference paper and could identify secondary tools a saliency model misses. Unusual tools, low contrast, specular metal, gaps, and topology still need evaluation. A recognized bounding box is not an accurate silhouette. [12]

fal exposes `return_multiple_masks` and `max_masks` up to 32, but these are endpoint response controls—not proof of exhaustive tool recall. Its masks need coordinate and alpha/grayscale validation. Roboflow separates SAM 3 visual segmentation (one prompted object per request) from concept segmentation (matching instances); SAM 2 supports corrective positive/negative points. [3][4]

For purely automatic tracing, benchmark text-prompted SAM 3. For a recovery flow, benchmark one positive point plus negative corrections. Do not compare a human-corrected result to an automatic baseline without reporting the human input.

### Gemini: generated stencils and native segmentation are different

Tracefinity currently asks an **image-generation/editing** model to create a black/white stencil. Current Google pricing lists Flash Image output at **$0.067 for 1K / $0.101 for 2K**, and Pro Image at **$0.134 for 1K/2K**, plus input/text charges. The price page uses newer non-preview model IDs whereas the repository config uses preview IDs; recheck the configured model before budgeting. These output fees are substantially above fal SAM 3 or Replicate BiRefNet. [13]

Google also documents native segmentation, but the inspected sources do not give one stable raster contract: the current image-understanding page presents normalized polygon JSON; the Gemini 3 migration guide recommends 2.5 Flash with thinking off for built-in pixel masks and excludes 3 Pro/Flash. Reports in Google's cookbook issue tracker and developer forum describe leaked mask tokens/corrupt base64. These are direct reports, not failures reproduced here. Native segmentation deserves at most a conditional prototype after verifying the exact model/API response, not a blind config substitution or guaranteed precision upgrade. [14]

## Commercial APIs and data handling

- **PhotoRoom:** maximum file size 50 MB, widest side 6000 px; recommends at most 25 MP for performance. Basic accepts uploaded image bytes; a URL-based Image Editing API is a different, more expensive plan. Large accepted files are not a guarantee of native-resolution mask accuracy. [6]
- **BRIA:** the reviewed endpoint explicitly returns transparency for local binarization. Hosted paid API usage is a separate evaluation from bundling gated/non-permissive weights into Tracefinity; check current service and model terms. Do not carry the old local-weight exclusion over as an automatic ban on a hosted trial. [5][11]
- **Replicate:** API prediction inputs, outputs, output files and logs are removed after one hour by default; web-interface predictions are retained indefinitely. This is a specific API retention policy, not a blanket claim about all service/account data. [15]
- **fal:** BiRefNet `sync_mode=true` returns a data URI and keeps output media out of request history. That is not a promise of zero input retention, no training, or immediate deletion across all endpoints. The SAM 3 schema's sync description promises data URI output, not the same history exclusion. [1][3]
- **Pixelcut:** its product page claims immediate image deletion, zero image retention/training, and encrypted transit. These are vendor claims, not an independent audit. [7]
- **Google:** the pricing page distinguishes free-tier product-improvement use from paid-tier non-use for improvement; that is not equivalent to zero retention. [13]
- **Roboflow, PhotoRoom, BRIA:** exact input/output retention and training-use guarantees were not established from the inspected endpoint pages; obtain applicable contractual terms before sensitive uploads.

**remove.bg is lower priority for a new integration:** it offers masks including `alpha.png` in ZIP output and up to 50 MP output, but its API page announces migration to Leonardo.Ai beginning **2026-12-01**. Current exact USD unit cost was not verified. Account/API migration obligations should be understood before choosing it for a new adapter. [16]

Claid was also inspected: its background-removal API returns an output URL and lists 2 API credits per image. Dollar conversion and a tool-specific advantage were not established, so it does not outrank the shortlist. [17]

## Minimal benchmark that would settle “better”

Use the same perspective-corrected photos and paper-crop policy for automatic foreground models. Include the recent drill/cutter/plier failures, multiple tools, bright metal, white/black tools, thin shanks, real holes/jaw gaps, shadowed/tinted paper, and overhangs. Add held-out photos, not only those used to tune prompts.

1. Manually annotate **visible silhouettes** and genuine holes; do not use generated Gemini masks as ground truth. Occluded hidden shape recovery is a separate task.
2. Compare current IS-Net / BiRefNet Lite / InSPyReNet, optional full local BiRefNet, existing cloud BiRefNet, fal 2048 and matched 2K variants, SAM 3, then BRIA/PhotoRoom. Record exact endpoint versions and prompts.
3. Measure tool recall, split/merged tools, paper/shadow false positives, missed holes/gaps, and boundary distances converted to **millimetres** using the same calibration. Also report mask IoU; do not select only on that aggregate score.
4. Inspect both the raw mask and the final contour: common resize, threshold, morphology and area filtering can destroy thin geometry even when the hosted mask is better.
5. Record total upload-to-result latency, failed calls, actual billed requests and correction effort. A provider's GPU inference time is not the user's waiting time.

Adopt a hosted option only if it reduces outline error/manual corrections enough to justify its cost, network dependency and privacy tradeoff. The present research selects experiments, not a proven accuracy winner.

## Primary sources

1. fal [BiRefNet v2 schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/birefnet/v2), [model listing](https://fal.ai/models/fal-ai/birefnet/v2).
2. Replicate [men1scus/birefnet model, price and typical runtime](https://replicate.com/men1scus/birefnet).
3. fal [SAM 3 image model, price and contract](https://fal.ai/models/fal-ai/sam-3/image), [OpenAPI](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/sam-3/image).
4. Roboflow [SAM 2](https://docs.roboflow.com/models/supported-models/sam2), [SAM 3](https://docs.roboflow.com/models/supported-models/sam3), [model credit rates](https://docs.roboflow.com/deployment/roboflow-cloud/serverless-api/model-pricing), [billing semantics](https://docs.roboflow.com/deployment/roboflow-cloud/serverless-api/pricing).
5. BRIA [Remove Background contract](https://docs.bria.ai/image-editing/editing/background-remove), [price list](https://bria.ai/pricing), [gated RMBG 2.0 model](https://huggingface.co/briaai/RMBG-2.0).
6. PhotoRoom [mask caveat](https://docs.photoroom.com/remove-background-api-basic-plan/download-the-segmentation-mask), [input limits and upload requirement](https://docs.photoroom.com/remove-background-api-basic-plan/file-size-resolution-and-format), [Basic/Plus pricing](https://www.photoroom.com/api/pricing). Pricing page text extraction was incomplete; the Basic $20/$0.02 rate was also visible in the indexed first-party pricing result.
7. Pixelcut [API rate, output/resolution and privacy claims](https://www.pixelcut.ai/api/background-remover), [API reference](https://www.pixelcut.ai/docs/api-reference/remove-background).
8. Replicate [meta/sam-2 price, typical runtime and variant](https://replicate.com/meta/sam-2).
9. BiRefNet [upstream repository](https://github.com/ZhengPeng7/BiRefNet), [HR checkpoint results](https://huggingface.co/ZhengPeng7/BiRefNet_HR).
10. Cloudflare [first-party background-removal evaluation](https://blog.cloudflare.com/background-removal/).
11. Tracefinity [issue #21 and maintainer's five-image benchmark](https://github.com/tracefinity/tracefinity/issues/21#issuecomment-4187296005).
12. Meta [SAM 3 source, model capabilities and checkpoint access](https://github.com/facebookresearch/sam3), [SAM 2 source](https://github.com/facebookresearch/sam2).
13. Google [Gemini API pricing and data-use distinction](https://ai.google.dev/gemini-api/docs/pricing).
14. Google [current image-understanding segmentation contract](https://ai.google.dev/gemini-api/docs/image-understanding#segmentation), [Gemini 3 segmentation exclusions](https://ai.google.dev/gemini-api/docs/gemini-3), [cookbook issue #798](https://github.com/google-gemini/cookbook/issues/798), [developer forum topic 146559](https://discuss.ai.google.dev/t/image-understanding-and-segmentation-mask-support/146559).
15. Replicate [API versus web prediction data retention](https://replicate.com/docs/topics/predictions/data-retention).
16. remove.bg [API output formats/limits and migration notice](https://www.remove.bg/api).
17. Claid [background-removal API](https://claid.ai/api-products/background-removal), [API credit pricing](https://claid.ai/api-pricing).
