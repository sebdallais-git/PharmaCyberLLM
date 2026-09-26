---
vendor: hpe
segment: storage-block
position: strong
confidence: high
as_of: 2026-09-21
# Block products only: a product is declared in exactly one brief. Alletra Storage
# MP X10000 and GreenLake File Storage are hpe-storage-file/object; StoreOnce, MSL
# and Zerto belong to hpe-data-protection; Private Cloud AI, PC3000/PC7000 and
# ClusterStor to hpe-ai-infrastructure / hpe-hpc. Alletra 5000 and 6000 are listed
# because the Swiss installed base runs on them, but see the portfolio section:
# they are the Nimble lineage and HPE is transitioning off them.
products: [Alletra Storage MP B10000, Alletra Block Storage for AWS, Alletra Block Storage for Azure, MSA Gen7, Alletra 5000, Alletra 6000]
competitors: [everpure, dell, netapp, huawei, ibm]
rationale: >
  HPE is a credible, well-regarded block contender that does not lead on share. Two independent
  reads of the 2026 Gartner MQ place HPE above both NetApp and Dell on combined axes, and Alletra
  Storage MP block orders have grown triple-digit year-over-year for six straight quarters. But
  IDC ranks HPE fifth of five in external storage revenue, HPE storage runs roughly a quarter of
  Dell's, and much of the block growth is a forced migration off its own end-of-life Nimble and
  3PAR estate rather than net new displacement.
sources:
  - https://www.blocksandfiles.com/block/2026/08/24/gartner-weaves-enterprise-storage-magic-spells-again/5291600
  - https://www.storagereview.com/news/gartner-magic-quadrant-for-enterprise-storage-2026-everpure-tops-both-axes-again-as-the-six-leaders-hold
  - https://www.blocksandfiles.com/flash/2026/06/16/idc-ranks-dell-netapp-everpure-huawei-and-hpe-in-external-storage-systems-market/5256070
  - https://www.blocksandfiles.com/ai-ml/2025/09/24/hpe-bigs-up-its-primary-block-afa-growth/1602478
  - https://www.blocksandfiles.com/file/2026/05/12/hpe-updates-alletras-x-and-b10000-zerto-and-data-fabric-in-greenlake-private-cloud-update-blast/5239011
  - https://www.blocksandfiles.com/block/2025/11/04/hpe-doubles-switchless-alletra-block-storage-node-count/1605527
  - https://www.blocksandfiles.com/ai-ml/2025/12/01/hpe-storage-in-2025-alletra-rises/1704439
  - https://www.blocksandfiles.com/ai-ml/2026/06/02/hpe-ai-drives-compute-and-networking-revenues-higher-while-storage-languishes/5250144
  - https://www.blocksandfiles.com/ai-ml/2026/09/03/hpes-record-results-buoyed-by-rising-ai-tide/5294254
  - https://www.blocksandfiles.com/ai-ml/2026/09/07/a-new-era-emerges-a-review-of-storage-supplier-revenue-from-2020-to-2026/5294796
  - https://www.blocksandfiles.com/architecture/2026/09/08/partner-content-hpe-makes-its-unified-storage-claim-real-as-b10000-r6-hits-ga/5294581
  - https://www.blocksandfiles.com/security/2025/05/20/transform-your-storage-ownership-experience-with-guaranteed-it-outcomes/1600659
  - https://www.hpe.com/us/en/storage/block-storage.html
  - https://www.hpe.com/us/en/products/storage/msa-shared-storage.html
---

## Portfolio — what HPE actually sells in block, and what each product is for

**Alletra Storage MP B10000 is the entire strategy:** disaggregated shared-everything — ProLiant controller nodes, separate NVMe JBOF shelves, RoCEv2 — so performance and capacity scale independently, switchless to four nodes (Blocks & Files, 2025-11-04). May 2026 added a sixth controller node in *single-node* increments and a 5:1 reduction guarantee; Release 6 put file on the same OS, GA September 2026 (Blocks & Files, 2026-05-12; HPE partner content, 2026-09-08). **Alletra Block Storage for AWS and Azure** run the same services in-cloud (Blocks & Files, 2025-12-01). **MSA Gen7** is the entry level (hpe.com, accessed 2026-09-21).

**Alletra 5000/6000 and Primera are the past, and that matters commercially.** Primera (3PAR) and Nimble folded into Alletra in 2023, and Neri told analysts "we are forcing a transition to our Alletra MP because also we are end-of-lifing legacy products" (Blocks & Files, 2025-12-01; 2026-06-02). HPE's block page lists only B10000 and X10000.

## Where HPE is strong — with evidence, not marketing adjectives

**Gartner places HPE above Dell here.** Of six Leaders in the 2026 Enterprise Storage Platforms MQ, Everpure is highest on both axes, Huawei second, then "HPE holds the strongest combined position of the remaining pack, NetApp and Dell cluster mid-quadrant" (StorageReview, 2026-08-21; Blocks & Files, 2026-08-24). **HPE's licensed reprint is self-selected — vendors reprint the quadrants they win. Cite the independent write-ups.**

**Block growth is fast and sustained.** Alletra Storage MP orders grew triple-digit year-over-year for six consecutive quarters to Q2 FY26 (Blocks & Files, 2026-06-02). HPE claims 14.5 percent primary-block AFA share and second place in primary block — but that is HPE quoting a non-public IDC tracker, with Mellor flagging the "top peers" hedge (Blocks & Files, 2025-09-24).

**Contractual guarantees are broader than Dell's:** 100 percent data availability, free non-disruptive controller upgrades, 4:1 data reduction, and cyber-resilience, zero-data-loss and energy SLAs with compensation for misses (HPE-contributed content, Blocks & Files, 2025-05-20 — terms offered, unverified).

## Where HPE is weak — and this is not softened

**Fifth of five.** IDC's 1Q26 tracker ranked external storage suppliers Dell, NetApp, Everpure, Huawei, HPE — in that order (Blocks & Files, 2026-06-16). Gartner's opinion and IDC's revenue disagree; say so.

**Storage is small and was flat.** Q2 FY26 storage was $1.2B, up 2.4 percent, "the weakest link"; Q3 FY26 recovered to $1.3B, up 10.2 percent (Blocks & Files, 2026-06-02; 2026-09-03). Dell's comparable quarter was $4.9B up 26 percent, leading "by a general 4x multiple", Everpure closing from below (2025-12-01; 2026-09-07).

**Much of the growth is a migration tax.** Triple-digit Alletra order growth sits inside 2–10 percent total growth because HPE is end-of-lifing its own base to fill it. A Basel or Stein site on Nimble or Primera faces a migration, not a refresh — under GxP, a requalification.

**Evidence hygiene is loose.** HPE's "86 percent of disruptions prevented" figure rests on ESG research from April 2021 (Blocks & Files, 2025-11-04). *Unverified:* HPE block revenue, an Alletra 5000/6000 end-of-sale date, and any block-level GxP or Part 11 programme.

## Competitive picture — HPE vs Dell, NetApp, Everpure, IBM, Huawei

**Dell.** B10000 versus PowerStore turns on the scaling model — HPE adds one controller node at a time against PowerStore's dual-controller-plus-clustering increments — while Dell answers with four times the revenue and a deeper Swiss base. **Everpure** tops both MQ axes a second year and is closing HPE's gap from below. **NetApp** trails HPE on the quadrant but leads on revenue, and ONTAP out-reaches Alletra Block for AWS/Azure — though HPE has cloud block where Dell has none. **IBM** and **Huawei** contest the high end, Huawei outranking HPE on execution but barred in practice from Swiss big-pharma.

## Pharma relevance

**cyber-resilience** is HPE's strongest card: real-time ransomware detection on the array across block and file, immutable snapshots, last-known-good snapshot identification, and an SLA with compensation (Blocks & Files, 2025-05-20; 2026-09-08). Dell's Cyber Detect reaches PowerStore only in Q3 2026 — HPE shipped first.

**manufacturing-ot** favours switchless 2–4 node B10000s: small, low-power, incrementally expandable clusters suit MES/LIMS/SCADA rooms at Visp or Kaiseraugst where rack and power are fixed (Blocks & Files, 2025-11-04).

**rnd-compute** is split: Blocks & Files judges HPE storage has "not benefitted much from neocloud AI training needs", losing to VAST, DDN and WEKA (2025-12-01) — but that is file, not block, and no concession to make here.

**data-sovereignty** is on-premises by construction, as with Dell; *unverified:* any HPE-operated Swiss sovereign service. **gxp-compliance:** neither vendor surfaces a block-level validation programme, but HPE's availability and zero-data-loss SLAs map to validation evidence more cleanly.

The `confidence: high` value rates how well-evidenced `position: strong` is — two independent reads of the 2026 MQ, a dated IDC ranking, exact quarterly figures and the CEO's own EOL statement all agreeing — not how good HPE is.
