---
vendor: hpe
segment: storage-object
position: present
confidence: low
as_of: 2026-09-21
# Object products only: a product is declared in exactly one brief, the segment it
# is sold as. Alletra Storage MP B10000 belongs to hpe-storage-block; GreenLake
# File Storage and the X10000's NFS layer to hpe-storage-file; HPE Data Fabric to
# hpe-data-management; Zerto, StoreOnce and the Cyber Resilience Vault to
# hpe-data-protection. The body discusses them where they bear on object.
products: [Alletra Storage MP X10000]
competitors: [dell, vast-data, scality, cloudian, minio]
rationale: >
  The X10000 is a real, HPE-owned, actively developed object platform -- four releases, unified
  file+object on one key-value foundation, vectorisation at ingest shipping today, and one genuinely
  independent lab validation -- and HPE sits ahead of Dell in the 2026 Gartner MQ. But nothing
  isolates object: no share figure, no object-specific quadrant, no customer count, no pharma
  reference. The system is also all-flash and capped at ~23 PB raw per cluster, and HPE only exited
  its Scality resale in March 2026, so its own object installed base is young. Present with low
  confidence is the honest read -- the same rating as the Dell object brief, for the same reason.
sources:
  - https://www.blocksandfiles.com/file/2026/09/17/its-here-doubled-alletra-mp-x10000-cluster-size-and-unified-fileobject/5297147
  - https://www.blocksandfiles.com/file/2026/05/12/hpe-updates-alletras-x-and-b10000-zerto-and-data-fabric-in-greenlake-private-cloud-update-blast/5239011
  - https://www.blocksandfiles.com/ai-ml/2026/09/03/hpes-record-results-buoyed-by-rising-ai-tide/5294254
  - https://www.blocksandfiles.com/ai-ml/2026/06/02/hpe-ai-drives-compute-and-networking-revenues-higher-while-storage-languishes/5250144
  - https://www.blocksandfiles.com/block/2026/08/24/gartner-weaves-enterprise-storage-magic-spells-again/5291600
  - https://www.blocksandfiles.com/ai-ml/2025/12/01/hpe-storage-in-2025-alletra-rises/1704439
  - https://blocksandfiles.com/2025/11/07/hpe-stops-selling-qumulo-scality-and-weka-software/
  - https://www.blocksandfiles.com/data-protection/2025/08/05/hpe-claims-worlds-fastest-backup-storage-with-alletra-x10000-upgrade/1586698
  - https://www.blocksandfiles.com/architecture/2025/02/13/hpe-alletra-x10000-redefines-scale-out-hardware/1606195
  - https://www.blocksandfiles.com/storage-management/2024/11/20/hpe-announces-object-storage-software-for-alletra-mp/1607549
  - https://www.blocksandfiles.com/ai-ml/2024/06/26/cloudian-gets-more-funding-as-it-reaches-breakeven-bags-hpe-greenlake-wins/1588636
  - https://www.blocksandfiles.com/file/2021/11/01/hpe-storage-strategy-edge-to-cloud-implies-fewer-software-partnerships/1601833
  - https://www.storagereview.com/review/hpe-alletra-storage-mp-x10000-with-the-data-protection-accelerator-node-backup-without-the-bottleneck
  - https://www.storagereview.com/news/hpe-alletra-storage-mp-x10000-release-4-is-ga-doubling-to-16-nodes-and-23pb-raw-and-adding-native-nfs-beside-object
  - https://www.storagereview.com/news/gartner-magic-quadrant-for-enterprise-storage-2026-everpure-tops-both-axes-again-as-the-six-leaders-hold
  - https://www.hpe.com/us/en/alletra-storage-mp-x10000.html
---

## Portfolio — what HPE actually sells in object, and what each product is for

**One product, and it is HPE's own IP.** Alletra Storage MP X10000 is an all-flash disaggregated-shared-everything system — ProLiant controller nodes, all-flash JBOFs, NVMe fabric — on a log-structured key-value store, not OEM'd software (Blocks & Files, 2025-02-13). S3 and S3a, triple-parity erasure coding, TLC and QLC flash (hpe.com, 2026-09-21).

**Release 4 (GA 17 September 2026)** doubles the supported cluster to 16 nodes and 16 JBOFs, about 23 PB raw, and adds native NFS v4.1 beside object, plus GPUDirect, KV-cache offload and active/active bucket replication (Blocks & Files, 2026-09-17).

**The partner era is over — this answers the Scality question.** HPE stopped quoting Scality, Qumulo and WEKA on 31 January 2026, refusing orders from 3 March 2026; Scality, for whom HPE was over half its business, moved to meet-in-the-channel (2025-11-07). The X10000 supersedes it. **Cloudian is unresolved:** HyperStore sold as a GreenLake service (2024-06-26), nothing since either way.

## Where HPE is strong — with evidence, not marketing adjectives

**Independent lab validation, which Dell's object story lacks.** StorageReview measured one data-protection accelerator node at 83.83 GB/s (~300 TB/hour) across 336 VMs, and four-node scaling to ~1.2 PB/hour, the bottleneck upstream rather than in the object target.

**Unification, where HPE is ahead of Dell.** File and object are first-class protocols on one key-value platform, no translation layer, no second silo (Blocks & Files, 2026-05-12) — and Gartner assumes over 80 percent of on-prem unstructured data sits on consolidated platforms by 2029 (2026-08-24). Dell answers with two products.

**The 2026 Gartner MQ puts HPE above Dell** — strongest combined position behind Everpure and Huawei, Dell and NetApp mid-quadrant (StorageReview, 2026-08-21). It does not isolate object, and its chart is credited "Source: Gartner, via HPE" — a self-selected reprint under independent analysis.

**Momentum, as reported, and intelligence shipping today.** Q3 FY26 storage revenue was $1.3B, up 10.2 percent, a record quarter, Alletra MP orders up "strong double digits" (2026-09-03). An optional Nvidia L40S node builds embeddings as objects land, with an in-array vector database queryable via Spark or Trino (2025-12-01) — Dell's is Q1 2027.

## Where HPE is weak — mandatory and substantive

**All-flash, and ~23 PB raw per cluster** — not exabyte-scale, and running into Gartner's warning to budget 250–300 percent of 2025 storage spend for 2027 on flash inflation (2026-08-24). QLC softens this; Scality still argues disk economics. The R4 scale-up was also a raised support limit, not an advance: it "has not come from any processor improvements or basic software advance" (2026-09-17).

**Storage is small at HPE, and it missed the AI training wave.** Dell leads it in storage revenue by roughly 4x, NetApp too, and HPE lost neocloud AI training to VAST, DDN and WEKA (2025-12-01); Q2 FY26 storage was "the weakest link" at +2.4 percent (2026-06-02).

**Object-isolated evidence is thin, and this is the main weakness.** No object share figure, no object quadrant, no customer count, no pharma reference, and the validated numbers are backup ingest, not object at archive scale. The 20x time-to-first-token and 17x throughput claims are vendor-commissioned Omdia testing hosted on hpe.com.

## Competitive picture — HPE vs Dell ObjectScale, VAST, Scality, Cloudian, MinIO

**Dell ObjectScale** has the larger storage business, exabyte ambition and Iceberg openness, and has added S3 over RDMA and KV-cache offload of its own (StorageReview, 2026-08-21), narrowing HPE's protocol lead; HPE counters with one platform instead of two. **VAST Data** is both the architecture the X10000 follows and still the OEM under HPE GreenLake File — customer and rival at once — and is absent from the 2026 MQ. **Scality** is an ex-partner turned channel rival on disk economics; **Cloudian and MinIO** rest on pre-2026 evidence only. Hyperscaler S3 is the unlisted alternative.

## Pharma relevance

**gxp-compliance.** R4 adds KMIP external key management. *Unverified:* S3 Object Lock or WORM retention, Part 11 validation, any object-level GxP programme, any named pharma customer. Immutability runs through Zerto (2025-08-05) — data protection, not the object store.

**data-sovereignty.** On-premises and customer-sited: the same structural argument Dell makes, no advantage either way, both US vendors. The multi-site angle is Data Fabric's federated namespace with lineage and geofencing (StorageReview, 2026-09) — HPE's framing, unaudited.

**cost-optimisation** is the exposed flank: all-flash, a ~23 PB ceiling, flash inflation. Catalyst reduces backup ingest up to 60:1, independently observed, but direct S3 backup only 6:1 to 7:1.

**cyber-resilience.** The X10000 as a fast backup target with Zerto and an air-gapped vault is genuine and independently exercised; note the top-25-ransomware-strain validation was on the B10000.

**Research data lakes and S3 as analytics substrate** is the strongest honest case: embeddings at ingest, a native vector database, and SQL engines over historical study data.

The `confidence: low` value rates the evidence behind `position: present`, not HPE's engineering: the one independent test covers backup ingest, not object at retention scale, and nothing isolates object commercially.
