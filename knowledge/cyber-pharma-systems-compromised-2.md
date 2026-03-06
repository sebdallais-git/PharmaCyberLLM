# IT Systems Compromised in Pharma Attacks (Continued)

## Common Systems and Applications Targeted Across Pharma Attacks

### Enterprise IT Systems Most Frequently Compromised
1. Active Directory: Compromised in 85%+ of major pharma breaches. Provides lateral movement and privilege escalation. Domain controllers are priority targets.
2. Microsoft Exchange / Microsoft 365: Email compromise is both an attack vector and a data exfiltration target. Compromised in 70%+ of incidents.
3. Citrix / VPN gateways: Remote access portals are the #1 external entry point. Change Healthcare (Citrix), multiple Pulse Secure VPN exploits (CVE-2021-22893), Fortinet VPN (CVE-2018-13379).
4. SAP ERP: Core business system in most large pharma companies. Compromise disrupts manufacturing, supply chain, and financial operations. Affected at Merck, Dr. Reddy's, Fresenius.
5. File servers / NAS: Research data, regulatory submissions, and IP stored on Windows file shares and NetApp/EMC storage. Primary target for data exfiltration.

### Pharma-Specific Applications Targeted
1. LIMS (Laboratory Information Management Systems): Core lab data management. Vendors: Thermo Fisher SampleManager, LabWare LIMS, Waters NuGenesis. Compromised at Synnovis, multiple CROs.
2. MES (Manufacturing Execution Systems): Control drug production. Vendors: Siemens SIMATIC IT, Rockwell FactoryTalk, SAP MES. Affected at Merck, Fresenius.
3. EHR/Pharmacy Management: Epic, Cerner (Oracle Health), Allscripts, McKesson Paragon. Compromised at UHS, CommonSpirit, Ascension, Scripps.
4. Automated Dispensing Cabinets: BD Pyxis, Omnicell, ARxIUM. Taken offline in hospital pharmacy attacks, requiring manual medication distribution.
5. EDMS (Electronic Document Management): Veeva Vault, Documentum, OpenText. Store regulatory submissions, SOPs, batch records. Targeted for IP theft.
6. CTMS (Clinical Trial Management Systems): Medidata Rave, Oracle InForm, Veeva Vault CTMS. Targeted in CRO attacks and for clinical trial data theft.
7. QMS (Quality Management Systems): TrackWise (Honeywell), MasterControl, Veeva Vault Quality. Compromise can affect GMP compliance status.
8. SCADA/DCS: Emerson DeltaV, Honeywell Experion, Siemens PCS 7. Control drug manufacturing processes. Snake/EKANS ransomware specifically targets these.
9. Chromatography Data Systems: Empower (Waters), Chromeleon (Thermo Fisher), OpenLab (Agilent). Store analytical testing data for drug quality.
10. ERP/Supply Chain: SAP S/4HANA, Oracle ERP Cloud, Microsoft Dynamics. Manage procurement, manufacturing, and distribution.

### Cloud Platforms Compromised in Pharma Attacks
1. Microsoft Azure / Microsoft 365: Most common cloud in pharma. Email compromise, SharePoint data theft, Azure AD attacks. Compromised in HSE Ireland, multiple phishing campaigns.
2. AWS: Used by many pharma companies for research computing and data lakes. S3 bucket misconfigurations exposed pharma data (Pfizer 2020, multiple others).
3. Salesforce: Pharma CRM and patient support platforms. Misconfigurations exposed prescription and patient data. Cencora's Lash Group platform.
4. Veeva Cloud: Pharma-specific cloud for clinical, quality, and regulatory. Vulnerability patched 2023. Stores critical drug development data.
5. Google Cloud / Google Workspace: Used by some pharma for research computing. Credential compromise through phishing.
6. Oracle Cloud: Clinical trial data (Oracle Health Sciences) and ERP. Targeted in CRO attacks.
7. Citrix Cloud / Virtual Desktop Infrastructure: Remote access for pharma workers. Entry point at Change Healthcare and many others.

## Attacks Categorized by System Type

### ERP System Attacks
- Merck NotPetya (2017): SAP completely disrupted, unable to process orders for weeks
- Dr. Reddy's (2020): SAP ERP shut down across all regions
- Fresenius (2020): SAP affected across multiple divisions
- Eisai (2023): Logistics systems (ERP-connected) disrupted in Japan and overseas
- Hoya (2024): Production control and ordering systems (ERP) down
- Cost of ERP downtime in pharma: Estimated $5-20M per day for large pharma

### Email System Attacks
- HSE Ireland (2021): Microsoft 365 email compromised, months to fully restore
- ExecuPharm (2020): Microsoft Exchange compromised, email data exfiltrated
- Eisai (2023): Email systems affected globally
- Medidata BEC (2020): Business Email Compromise targeting clinical trial payments, $4.7M stolen
- Bayer (2019): Email servers compromised by Winnti for long-term surveillance
- Pharma BEC statistics: Average loss $1.2M per incident, often targeting accounts payable for drug ingredient purchases

### VPN and Remote Access Attacks
- Change Healthcare (2024): Citrix NetScaler without MFA - led to $2.87B incident
- Multiple pharma companies via Pulse Secure VPN (2021): CVE-2021-22893 zero-day exploited by Chinese APT
- Fortinet VPN exploits (2020-2023): Multiple pharma companies compromised via CVE-2018-13379 and later vulnerabilities
- COVID-era VPN expansion: Rapid deployment of remote access during pandemic created security gaps across pharma sector
- SonicWall VPN exploits (2021): Affected pharma companies using SonicWall SMA appliances

### Database and Data Warehouse Attacks
- Anthem (2015): Oracle databases and Teradata data warehouse, 78.8M records
- PharMerica (2023): Patient database systems, 5.8M records
- Cencora (2024): Patient support program databases across multiple pharma companies
- HCA Healthcare (2023): Database containing 11M patient records including prescriptions
- CVS Health (2021): Elasticsearch database misconfiguration, 1B+ records exposed
- Common databases in pharma: Oracle (most common for regulated data), Microsoft SQL Server, PostgreSQL, MongoDB (research), Elasticsearch (analytics)

### Manufacturing and OT System Attacks
- Merck NotPetya (2017): MES and production systems destroyed, manufacturing halted globally
- Fresenius Snake/EKANS (2020): ICS processes specifically targeted (GE Proficy historian, Honeywell HMI)
- Hoya (2024): Production control systems at multiple factories halted
- Norsk Hydro LockerGoga (2019): OT systems at pharma packaging supplier, $75M cost
- Dr. Reddy's (2020): Manufacturing systems isolated, plants in 5 countries shut down
- Common pharma OT systems targeted: Siemens PCS 7/SIMATIC, Emerson DeltaV, Honeywell Experion PKS, Rockwell ControlLogix, ABB 800xA
- SCADA protocols at risk: Modbus, DNP3, OPC UA - often unencrypted in pharma manufacturing

### Clinical Trial System Attacks
- EMA/Pfizer/BioNTech (2020): EudraLink document management, regulatory submission portals
- IQVIA MOVEit (2023): Clinical trial file transfer systems compromised via CLOP exploitation
- Medidata BEC (2020): Clinical trial payment systems, $4.7M stolen via email compromise
- Parexel/ExecuPharm (2020): Clinical trial documents and data exfiltrated
- Common clinical trial systems targeted: Medidata Rave (eClinical), Oracle InForm (EDC), Veeva Vault CTMS, Signant Health (eCOA), IQVIA platforms
- Risk: Clinical trial data loss can require study repetition ($50-500M) and regulatory delays

### Pharmacy Dispensing System Attacks
- UHS Ryuk (2020): Pyxis automated dispensing cabinets offline at 400 facilities
- Ascension Black Basta (2024): Pharmacy ordering and Pyxis systems down at 140 hospitals
- CommonSpirit (2022): Pharmacy management systems offline, no electronic drug interaction checks
- Scripps Health (2021): Pharmacy systems manual for 4 weeks
- WannaCry NHS (2017): JAC pharmacy dispensing systems offline at 80+ trusts
- Common pharmacy systems affected: BD Pyxis MedStation, Omnicell XT, Epic Willow (pharmacy module), McKesson Robot-Rx, ScriptPro

### File Transfer System Attacks (Supply Chain Vector)
- MOVEit Transfer exploitation (2023): CLOP ransomware group exploited zero-day CVE-2023-34362. Affected IQVIA, multiple pharma benefit companies, healthcare organizations. Over 2,500 organizations globally.
- Accellion FTA exploitation (2021): Zero-day in legacy file transfer appliance affected multiple pharma and healthcare organizations
- GoAnywhere MFT exploitation (2023): CLOP exploited CVE-2023-0669, affecting pharma companies using the managed file transfer platform
- Key lesson: Pharma companies use many file transfer tools to share regulated data with CROs, regulatory agencies, and partners. These are high-value targets.

## Infrastructure Patterns Across Pharma Attacks

### Most Common Attack Path in Pharma
1. Initial access: Phishing email or compromised VPN/Citrix credentials
2. Credential theft: Mimikatz or similar tool harvests Active Directory credentials
3. Lateral movement: Attacker moves through Windows network using stolen domain admin credentials
4. Data staging: Sensitive data (IP, patient records, financial data) copied to staging server
5. Exfiltration: Data uploaded to attacker infrastructure (cloud storage, Mega, etc.)
6. Encryption: Ransomware deployed across domain via Group Policy or PsExec
7. Extortion: Double extortion - ransom demand plus threat to publish stolen data

### Common Technology Stack in Affected Pharma Companies
- Identity: Microsoft Active Directory (90%+), Azure AD/Entra ID
- Email: Microsoft 365 / Exchange (85%+), some Google Workspace
- Endpoints: Windows 10/11 (corporate), Windows 7/XP (manufacturing legacy)
- Servers: Windows Server 2016/2019, Red Hat Enterprise Linux, SUSE
- ERP: SAP S/4HANA (60%+ of large pharma), Oracle ERP
- Cloud: Azure (most common), AWS, GCP
- Remote access: Citrix, Pulse Secure/Ivanti, GlobalProtect, Cisco AnyConnect
- Collaboration: Microsoft Teams, SharePoint, Slack
- CRM: Salesforce, Veeva CRM
- Backup: Veeam, Commvault, Veritas NetBackup (attackers specifically target backup systems)
