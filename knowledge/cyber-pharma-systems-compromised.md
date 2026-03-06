# IT Systems and Applications Compromised in Pharma Cyber Attacks

## Landmark Attacks - Detailed System Impact

### Merck NotPetya (2017)
- Initial vector: MeDoc Ukrainian accounting software auto-update mechanism (supply chain)
- Propagation: EternalBlue (SMBv1 exploit, MS17-010) and Mimikatz credential harvesting for lateral movement
- Systems compromised:
  - Windows-based Active Directory domain controllers across global network
  - Windows 7 and Windows Server 2008/2012 endpoints (40,000+ machines bricked)
  - SAP ERP system for manufacturing and supply chain management
  - Manufacturing Execution Systems (MES) at production facilities
  - Email servers (Microsoft Exchange)
  - File servers containing research and regulatory data
  - LIMS (Laboratory Information Management Systems)
  - Merck's global WAN infrastructure
- Cloud: Primarily on-premises infrastructure affected; cloud services less impacted
- Applications: SAP, Microsoft Office/Exchange, custom pharma manufacturing applications, quality management systems
- Key detail: The malware overwrote the Master Boot Record (MBR), making machines unbootable. Merck had to replace 40,000+ computers and 7,500+ servers.

### Change Healthcare / UnitedHealth (2024)
- Initial vector: Compromised credentials on Citrix remote access portal (no MFA enabled)
- Systems compromised:
  - Citrix NetScaler remote access gateway
  - Active Directory for lateral movement
  - Claims processing platform handling 15 billion transactions/year
  - Pharmacy claims adjudication system (used by 67,000+ pharmacies)
  - Electronic Data Interchange (EDI) clearinghouse systems
  - Eligibility verification systems
  - Prior authorization platforms
  - Payment processing and remittance systems
  - Clinical data exchange platform
  - Revenue cycle management applications
- Cloud: Hybrid infrastructure; both on-premises data centers and cloud-hosted services affected
- Applications: Assurance (claims), RelayHealth (pharmacy network), ConnectCenter, Change Healthcare Platform APIs
- Key detail: Single point of failure - Change Healthcare processes ~50% of all US medical claims. No MFA on the Citrix gateway was the root cause.

### NHS WannaCry (2017)
- Initial vector: EternalBlue exploit (MS17-010) targeting unpatched Windows systems
- Systems compromised:
  - Windows XP machines (still widely used across NHS)
  - Windows 7 endpoints without March 2017 security patch
  - Hospital pharmacy dispensing systems (JAC, EMIS, Ascribe)
  - Electronic prescription service (EPS)
  - Patient Administration Systems (PAS)
  - Radiology PACS (Picture Archiving and Communication Systems)
  - NHS mail servers
  - GP practice management systems (EMIS Web, SystmOne, Vision)
  - Blood bank management systems
- Cloud: Minimal cloud at the time; mostly on-premises NHS infrastructure
- Applications: NHS Spine (national patient record), Choose and Book, e-Referral Service, EMIS, SystmOne
- Key detail: 80+ NHS trusts affected. 19,500 appointments cancelled. Pharmacy dispensing reverted to paper for weeks at many sites.

### AstraZeneca North Korean Attack (2020)
- Initial vector: Spear-phishing via LinkedIn (fake recruiter profiles from Lazarus Group)
- Targeted systems:
  - Employee endpoints via malicious documents with embedded macros
  - VPN and remote access infrastructure
  - COVID-19 vaccine research databases and file shares
  - Active Directory credentials
  - Internal collaboration platforms
- Cloud: Targeted cloud-hosted research repositories
- Applications: Targeted Microsoft Office documents, internal R&D platforms
- Key detail: Attack was detected and blocked before significant compromise. Malicious documents contained code designed to establish persistent backdoor access.

### Pfizer/BioNTech EMA Breach (2020)
- Initial vector: Targeted intrusion on European Medicines Agency IT infrastructure
- Systems compromised:
  - EMA document management system (EudraLink)
  - Regulatory submission portal
  - CESP (Common European Submission Platform)
  - EMA email servers
  - Internal file storage containing COVID-19 vaccine dossier
- Cloud: EMA's centralized IT infrastructure (hybrid cloud/on-premises)
- Applications: EudraLink, EudraVigilance access portals, CESP
- Key detail: Stolen documents were manipulated before being leaked online to undermine vaccine confidence. Modified emails between EMA and pharma companies were published.

### Dr. Reddy's Laboratories Ransomware (2020)
- Initial vector: Unknown (suspected phishing or exposed RDP)
- Systems compromised:
  - Data center servers across multiple countries (Brazil, India, Russia, UK, US)
  - ERP system (SAP)
  - Manufacturing execution systems
  - Quality management systems
  - Email and collaboration platforms
  - File servers containing R&D data
- Cloud: Primarily on-premises data centers
- Applications: SAP ERP, Microsoft Exchange, manufacturing quality systems
- Key detail: All data center services were proactively isolated within hours of detection. Plants shut down as precautionary measure.

### Sun Pharmaceuticals ALPHV/BlackCat (2023)
- Initial vector: Unknown initial access
- Systems compromised:
  - Corporate file systems (data exfiltrated to dark web)
  - Revenue and business operations systems
  - Employee personal data systems (HR/payroll)
  - Email servers
  - Some manufacturing-related IT systems
- Cloud: Hybrid infrastructure affected
- Applications: ERP, HR systems, email, file sharing platforms
- Key detail: ALPHV published stolen data on their leak site. Revenue impact disclosed in quarterly filing.

### Eisai Ransomware (2023)
- Systems compromised:
  - Multiple servers encrypted (on-premises)
  - Logistics and distribution systems in Japan and overseas
  - Corporate websites
  - Email system (Microsoft Exchange/365)
  - Internal file servers
- Cloud: Both on-premises and cloud-connected systems
- Applications: Logistics/SCM platforms, corporate web applications, email
- Key detail: Company disclosed that logistics systems were most severely impacted, affecting drug distribution timelines.

### ExecuPharm/Parexel CLOP Ransomware (2020)
- Initial vector: Phishing email delivering CLOP ransomware
- Systems compromised:
  - File servers containing clinical trial data
  - Email servers (Microsoft Exchange)
  - Financial record systems (accounting/ERP)
  - HR and employee data systems
  - Document management systems with regulatory filings
- Cloud: Primarily on-premises
- Applications: Microsoft Exchange, document management, financial systems
- Key detail: CLOP operators exfiltrated data before encryption and published it when ransom wasn't paid, including social security numbers and financial records.

### Fresenius Group Snake/EKANS Ransomware (2020)
- Initial vector: Unknown
- Systems compromised:
  - IT systems across Fresenius Kabi (pharma), Fresenius Helios (hospitals), Fresenius Medical Care
  - Windows-based servers and endpoints
  - Specifically targeted ICS/SCADA processes (Snake/EKANS feature)
  - Manufacturing control systems
  - SAP ERP
  - Email and communications
- Cloud: Hybrid infrastructure
- Applications: SAP, manufacturing execution systems, ICS/SCADA applications
- Key detail: Snake/EKANS ransomware was specifically designed to kill ICS processes before encrypting, including GE Proficy, Honeywell HMI processes - indicating manufacturing targeting.

### Bayer Winnti APT (2019)
- Initial vector: Winnti malware (likely via supply chain or spear-phishing)
- Systems compromised:
  - Active Directory infrastructure
  - Internal network (persistent backdoor access for months)
  - R&D systems and databases
  - Intellectual property repositories
  - Email servers
- Cloud: Targeted on-premises R&D infrastructure
- Applications: Winnti backdoor installed on Windows servers, targeted custom R&D applications
- Key detail: Bayer discovered the intrusion in early 2019 but determined access had been maintained since 2018. Winnti group linked to Chinese state-sponsored espionage.

### Cencora/AmerisourceBergen Data Breach (2024)
- Initial vector: Unauthorized access (specific vector undisclosed)
- Systems compromised:
  - Patient support program databases
  - Lash Group patient services platform (hub services for pharma companies)
  - Data systems serving AbbVie, Bayer, Bristol-Myers Squibb, Genentech, Novartis, Pfizer, Regeneron, and others
  - Patient PII and medical data repositories
- Cloud: Cloud-hosted patient services platforms
- Applications: Lash Group hub services platform, patient assistance program systems, CRM systems
- Key detail: Breach affected patient data from 27+ pharma company programs. Cencora is the second-largest US pharma distributor.

### Hoya Corporation Hunters International (2024)
- Systems compromised:
  - Production control systems at multiple factories
  - Ordering and inventory management systems
  - Lens processing manufacturing systems
  - Corporate IT infrastructure
- Cloud: Hybrid manufacturing/IT infrastructure
- Applications: Production control, ERP, ordering systems
- Key detail: Production halted at multiple factories. Hunters International (rebrand of Hive ransomware) demanded $10M.

### Universal Health Services Ryuk (2020)
- Initial vector: Phishing email leading to Emotet/TrickBot, then Ryuk deployment
- Systems compromised:
  - Active Directory across 400 facilities
  - Epic EHR/pharmacy management system
  - Allscripts clinical systems
  - Phone systems (VoIP)
  - Lab systems
  - Pharmacy dispensing systems (Pyxis/BD, Omnicell)
  - Radiology systems
  - All Windows-based infrastructure
- Cloud: Primarily on-premises Epic deployment
- Applications: Epic EHR, Allscripts, pharmacy dispensing (Pyxis), Citrix virtual desktop infrastructure
- Key detail: All 400 facilities reverted to paper. Pharmacy staff manually tracked medications. $67M total cost disclosed.

### CommonSpirit Health Ransomware (2022)
- Systems compromised:
  - Epic EHR and associated clinical systems
  - MyChart patient portal
  - Pharmacy management systems
  - Medical device networks at some facilities
  - IT infrastructure at 140+ hospitals
  - Scheduling systems
- Cloud: Epic hosted environment and associated cloud services
- Applications: Epic EHR, MyChart, pharmacy management, scheduling platforms
- Key detail: Pharmacies at affected hospitals couldn't verify allergies or drug interactions electronically for weeks.

### Ascension Health Black Basta (2024)
- Initial vector: Employee downloaded malicious file
- Systems compromised:
  - Epic EHR across 140 hospitals
  - MyChart patient portal
  - Pharmacy ordering and dispensing systems
  - Phone systems
  - Lab ordering systems
  - Medical device connectivity
  - Various clinical and business systems
- Cloud: Epic cloud-hosted EHR and associated services
- Applications: Epic EHR, MyChart, pharmacy management, Pyxis medication dispensing, lab information systems
- Key detail: Nurses and pharmacists reverted to paper records. Medication administration required manual verification. Some hospitals diverted ambulances.

### HSE Ireland Conti (2021)
- Initial vector: Phishing email with malicious Excel attachment
- Systems compromised:
  - Active Directory domain controllers
  - 80,000+ endpoints across Irish health service
  - Hospital pharmacy systems
  - Patient administration systems
  - National immunization system
  - NIMIS (National Integrated Medical Imaging System)
  - Lab information systems
  - Email (Microsoft 365)
  - File shares containing patient data
  - GP referral systems
- Cloud: Microsoft 365, hybrid infrastructure
- Applications: HIPE, iPMS (patient management), pharmacy systems, NIMIS, lab systems, email
- Key detail: Conti demanded $20M ransom. HSE refused to pay. Decryption key was eventually provided but recovery still took months. Total cost $600M+.

### Anthem Breach (2015)
- Initial vector: Spear-phishing targeting Anthem IT employee (APT Deep Panda/China-linked)
- Systems compromised:
  - Enterprise Data Warehouse containing 78.8M records
  - Membership database
  - Claims processing systems
  - Active Directory (credentials stolen for lateral movement)
  - Multiple Oracle databases
- Cloud: Primarily on-premises data warehouse
- Applications: Custom membership and claims platforms, Oracle databases, Teradata data warehouse
- Key detail: Attackers had access for 9 months before detection. Stole entire membership database including SSNs.

### PharMerica Money Message (2023)
- Systems compromised:
  - Patient database systems (5.8M records)
  - Pharmacy management systems
  - Prescription data platforms
  - Corporate file servers
- Cloud: Hybrid infrastructure
- Applications: Pharmacy management system, patient record databases
- Key detail: Money Message group published stolen data including names, SSNs, medications, and health insurance information.

### Synnovis/UK Pathology (2024)
- Initial vector: Qilin ransomware
- Systems compromised:
  - Laboratory Information Management Systems (LIMS)
  - Blood testing and pathology result systems
  - Electronic order communication systems with hospitals
  - Patient result delivery platforms
  - Internal IT infrastructure
- Cloud: Hybrid lab/IT infrastructure
- Applications: LIMS, pathology reporting systems, hospital integration interfaces (HL7/FHIR)
- Key detail: Major London hospitals (King's College, Guy's, St Thomas') couldn't receive lab results for months. 10,000+ blood test appointments cancelled. Pharmaceutical dosing decisions delayed.

### Medibank REvil (2022)
- Initial vector: Stolen credentials from a third-party IT provider
- Systems compromised:
  - Customer database (9.7M records)
  - Claims management system
  - AHM (subsidiary) customer systems
  - Internal network via VPN access
  - File servers containing health data
- Cloud: Hybrid cloud infrastructure
- Applications: Customer management, claims processing, VPN/remote access platforms
- Key detail: REvil threatened to release data in batches. Published sensitive health records including mental health, addiction treatment, and pregnancy termination data.

### Scripps Health Ransomware (2021)
- Systems compromised:
  - Epic EHR
  - Patient portal
  - Pharmacy management systems
  - Email
  - Website
  - Radiology systems
  - Lab systems
- Cloud: Hosted EHR and cloud email
- Applications: Epic EHR, pharmacy management, radiology PACS, lab information systems
- Key detail: Four hospitals and 19 outpatient facilities affected. Pharmacy operations manual for 4 weeks. $113M total cost.
