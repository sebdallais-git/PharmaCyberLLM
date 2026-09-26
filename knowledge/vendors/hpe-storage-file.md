---
vendor: hpe
segment: storage-file
position: strong
confidence: medium
as_of: 2026-09-21
# File products only, one OFFERS edge per product. Alletra Storage MP X10000 is
# declared in hpe-storage-object -- it began as the object platform and gained
# file in 2026 -- and B10000 in hpe-storage-block. This brief owns the offerings
# sold as file; the body is free to discuss the file personality of the others,
# which is where the fight actually is.
products: [HPE GreenLake for File Storage, HPE Cray ClusterStor E1000, HPE Cray Supercomputing Storage Systems E2000]
competitors: [dell, vast-data, weka, netapp, everpure, ddn]
rationale: >
  HPE is genuinely strong in file, and stronger than Dell in two places: HPC parallel filesystems, where
  Cray ClusterStor holds exascale wins and IO500 positions Dell has no answer to, and storage momentum,
  where HPE posted a record storage quarter at +10.2% while Dell storage shrank. It is not a leader
  because the enterprise scale-out file franchise is mid-transition between an OEM'd VAST filesystem and
  an HPE-native one that reached GA four days before this date, and HPE has said it is not chasing the
  traditional filer.
sources:
  - https://www.blocksandfiles.com/file/2026/05/12/hpe-updates-alletras-x-and-b10000-zerto-and-data-fabric-in-greenlake-private-cloud-update-blast/5239011
  - https://www.blocksandfiles.com/file/2026/09/17/its-here-doubled-alletra-mp-x10000-cluster-size-and-unified-fileobject/5297147
  - https://www.blocksandfiles.com/file/2025/11/07/hpe-stops-selling-qumulo-scality-and-weka-software/1721655
  - https://www.blocksandfiles.com/ai-ml/2025/12/01/hpe-storage-in-2025-alletra-rises/1704439
  - https://www.blocksandfiles.com/ai-ml/2026/09/03/hpes-record-results-buoyed-by-rising-ai-tide/5294254
  - https://www.blocksandfiles.com/ai-ml/2026/06/02/hpe-ai-drives-compute-and-networking-revenues-higher-while-storage-languishes/5250144
  - https://www.blocksandfiles.com/ai-ml/2025/10/27/latest-oak-ridge-national-labs-discovery-supercomputer-gets-daos-storage-option/1594265
  - https://www.blocksandfiles.com/data-management/2026/06/19/storage-news-ticker-19-june-2026/5259093
  - https://www.blocksandfiles.com/block/2023/04/04/hpe-greenlake-taps-vast-data-for-file-storage/1614009
  - https://www.blocksandfiles.com/architecture/2026/09/08/partner-content-hpe-makes-its-unified-storage-claim-real-as-b10000-r6-hits-ga/5294581
  - https://www.storagereview.com/news/gartner-magic-quadrant-for-enterprise-storage-2026-everpure-tops-both-axes-again-as-the-six-leaders-hold
  - https://www.hpe.com/us/en/collaterals/collateral.a50009618enw.html
  - https://www.hpe.com/us/en/greenlake/file-storage.html
  - https://www.hpe.com/us/en/newsroom/press-release/2025/10/hpe-to-build-two-systems-for-oak-ridge-national-laboratory-next-generation-exascale-supercomputer-discovery-and-ai-cluster-lux.html
---

## Portfolio — what HPE actually sells in file, and what each product is for

**Two filesystems under one brand, plus a separate HPC line.** HPE GreenLake for File Storage, launched 2023, runs **OEM'd VAST Data software** on Alletra Storage MP hardware (Blocks & Files, 2023-04-04). Not history: HPE's live product page still footnotes its six-nines claim to "VAST Data software" (hpe.com, accessed 2026-09-21).

Alongside it, HPE has written its own filesystem from scratch — announced May 2026 on the Alletra MP X10000, POSIX, NFS v4.1, on the same key-value store as HPE's object stack, GA 2026-09-17 in Release 4 with file RDMA and Nvidia GPUDirect, 16 nodes/16 JBOFs and ~23 PB raw (Blocks & Files, 2026-05-12, 2026-09-17). The block-side B10000 gained file in Release 6 (Blocks & Files partner content, 2026-09-08 — **sponsored**). The HPC line is Cray-derived: ClusterStor E1000 and E2000 (Lustre), plus the K3000 DAOS system (hpe.com newsroom, 2025-10-27).

## Where HPE is strong — with evidence, not marketing adjectives

**HPC parallel file, where Dell has nothing equivalent shipping.** Frontier runs 700 PB+ of ClusterStor E1000; El Capitan and Los Alamos Mission/Vision are HPE builds; ORNL's Discovery takes E2000 and K3000 (Blocks & Files, 2025-10-27). Mellor credits ClusterStor with "IO500-leading data performance" (2025-12-01). Dell Exascale and Lightning are futures.

**Storage momentum runs the opposite way to Dell's.** Q3 FY26 storage was $1.3B, up 10.2% — a record quarter, Alletra MP orders and revenue up "strong double digits", HPE outpacing Everpure (Blocks & Files, 2026-09-03). Dell's storage line shrank over the comparable period. Say so plainly rather than let the customer discover it.

**MQ position is ahead of Dell's.** HPE "holds the strongest combined position of the remaining pack" behind Everpure and Huawei, Dell mid-quadrant (StorageReview on the 2026 Gartner MQ for Enterprise Storage Platforms, 2026-08-21). Caveats: the chart is sourced "Gartner, via HPE" — self-selected — and Gartner tracks high-performance file separately, so the MQ does not adjudicate this segment.

**A Swiss proof point.** CSCS at ETH Zurich runs Alps on HPE Cray EX and took the CUG 2026 Best Paper for "Enabling Trusted Research Environments on HPE Cray EX Systems" (Blocks & Files, 2026-06-19).

## Where HPE is weak — mandatory and substantive

**The franchise is mid-swap, and the native filesystem is four days old.** Two filesystems, both supported, quoted under one brand (Blocks & Files, 2026-05-12). The HPE-native one hit GA 2026-09-17: no independent benchmarks, no installed base, no references. HPE's own framing is modest — the first release "literally has performance on par with our object store", i.e. object-class, not a tuned filer.

**HPE has conceded the enterprise filer.** SVP Jim O'Dorisio: "We're not going after, at least not initially, the traditional filer environment per se" (2026-05-12). Much GxP-retained pharma file data sits exactly there.

**Scale ceiling, and no third-party file to fall back on.** 16 nodes and ~23 PB raw supported, against much larger PowerScale clusters (2026-09-17); and Qumulo, Scality and WEKA resale ended 3 March 2026 (Blocks & Files, 2025-11-07), so HPE can no longer put WEKA on its own paper.

**It has lost the AI-file land grab so far.** HPE storage "has not benefitted much from neocloud AI training needs, losing out to VAST Data, DDN, and WEKA", and ClusterStor "has not featured in Nvidia GPU-based supercomputers" (2025-12-01). Storage was "the weakest link" at +2.4% in Q2 FY26, growth partly forced by end-of-lifing legacy arrays (2026-06-02). The Omdia KV-cache claims (20x time-to-first-token) sit on hpe.com — vendor-commissioned; never concede them untested.


## Competitive picture — HPE vs Dell, VAST Data, WEKA, NetApp

**Against Dell**, HPE wins on HPC parallel file and storage growth; Dell wins on installed base, cluster scale and OneFS maturity. **Against VAST Data** the position is odd: on a GreenLake for File bid HPE is reselling VAST, so the real bake-off is PowerScale vs VAST, with HPE adding GreenLake consumption and one throat to choke. **WEKA** is now a channel rival, not an HPE component. **NetApp** outsells HPE and holds the first-party cloud-file position HPE lacks; **Everpure** tops both MQ axes but HPE outgrew it last quarter.

## Pharma relevance

**rnd-compute.** Cryo-EM and HPC scratch are HPE's best ground — ClusterStor/E2000 is a credible Lustre answer, Alps the local proof. Genomics and NGS are the opposite: small-file, metadata-heavy work is exactly what the four-day-old native filesystem has never been shown to do. Bake off on the customer's own FASTQ/BAM.

**data-sovereignty.** The Trusted Research Environment work on Cray EX is Swiss-local and real (2026-06-19), and GreenLake gives an on-prem consumption model — HPE's strongest non-performance argument.

**cyber-resilience.** X10000 R4 adds KMIP external key management and TLS 1.3; Zerto integrates with Microsoft Defender (2026-05-12, 2026-09-17). Detection sits in data protection, not the filesystem.

**gxp-compliance.** *Unverified:* no HPE file-specific GxP or Part 11 validation programme surfaced in any independent source searched. Probe it; do not assume absence.

The `confidence: medium` value rates the evidence behind `position: strong`, not HPE's quality: the HPC and financial evidence is independent, but the decisive enterprise-file facts are days old, unbenchmarked by third parties, and entangled with an OEM relationship HPE is quietly displacing.
