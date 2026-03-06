# Cyber Attack Types Targeting Pharma

## Ransomware

### Overview
Ransomware is the #1 cyber threat to pharmaceutical companies. Attackers encrypt systems and demand payment, often also exfiltrating data for double extortion. Pharma is heavily targeted because of high willingness to pay due to patient safety and regulatory obligations.

### Common Ransomware Groups Targeting Pharma
- ALPHV/BlackCat: Responsible for Change Healthcare ($2.87B), Sun Pharma, McLaren, Norton Healthcare attacks
- LockBit: Prolific group targeting healthcare/pharma globally. MCNA Dental (8.9M records), multiple hospital pharmacies
- CLOP: ExecuPharm/Parexel attack, MOVEit exploitation affecting pharma benefit companies
- Conti: HSE Ireland ($600M), numerous hospital pharmacy disruptions before disbanding in 2022
- REvil/Sodinokibi: Medibank attack (9.7M records), JBS (pharma supply chain crossover)
- Ryuk: Universal Health Services ($67M), DCH Health, numerous hospital pharmacies
- Hive: Supernus Pharmaceuticals, multiple healthcare targets before takedown in 2023
- Black Basta: Ascension Health (2024), significant pharmacy disruption
- Rhysida: Prospect Medical Holdings, targeting hospital pharmacy operations
- Money Message: PharMerica (5.8M records)
- Snake/EKANS: Specifically designed to target industrial control systems (ICS), Fresenius attack
- Maze: Hammersmith Medicines Research (COVID trial site)
- Hunters International: Hoya Corporation, emerging threat to pharma manufacturing

### Ransomware Statistics in Pharma
- Average ransom demand for pharma: $4.6M (2024)
- Average ransom payment for pharma: $1.5M (2024)
- Percentage of pharma companies that paid ransom: 47% (2023 survey)
- Average downtime from ransomware in pharma: 21 days
- Average total cost including recovery: $10.9M per incident (2024)
- Double extortion (encrypt + steal data): Used in 82% of pharma ransomware attacks
- Triple extortion (encrypt + steal + threaten patients/partners): Growing trend

## Nation-State Espionage (APT)

### Overview
Advanced Persistent Threats (APTs) target pharma for intellectual property theft, especially drug formulas, clinical trial data, and manufacturing processes. Attackers maintain long-term stealth access.

### Key Nation-State Actors Targeting Pharma
- China (APT10, APT41, Winnti): Long history of pharma IP theft. Targeted Bayer, Roche, multiple CROs. Cloud Hopper campaign compromised managed service providers serving pharma. Focus: drug formulations, clinical trial data, manufacturing processes.
- North Korea (Lazarus Group, Kimsuky): Targeted AstraZeneca COVID vaccine research. Also financially motivated (ransomware to fund regime). Focus: vaccine IP, financial theft.
- Russia (APT28/Fancy Bear, APT29/Cozy Bear): Targeted COVID-19 vaccine research at multiple companies. UK/US/Canada joint advisory in July 2020. Focus: vaccine and therapeutic research.
- Iran (APT33/Elfin, APT35/Charming Kitten): Targeted pharma companies and health organizations. Focus: sanctions-related pharma access, IP theft.

### APT Attack Costs in Pharma
- Average cost of nation-state espionage in pharma: Difficult to quantify, estimated $100M-$1B+ in lost IP value per major incident
- Dwell time (time before detection): Average 197 days for APT in pharma (2023)
- Remediation time: 3-12 months average
- Cost of stolen drug formula IP: Can represent billions in R&D investment

## Phishing and Social Engineering

### Overview
Phishing remains the most common initial attack vector in pharma, used in 36% of breaches. Pharma employees are targeted with industry-specific lures.

### Common Pharma Phishing Themes
- FDA/EMA regulatory notices and fake compliance alerts
- Clinical trial enrollment communications
- Fake supplier invoices and purchase orders
- COVID-19 themed phishing (peaked 2020-2021 but continues)
- Fake job offers targeting researchers (North Korean tactic)
- Conference and medical journal submission lures
- Drug safety alert spoofing
- Pharmacy benefit authorization phishing

### Phishing Statistics in Pharma
- 36% of pharma breaches start with phishing (2024)
- Average cost of phishing-initiated breach in pharma: $5.3M
- Business Email Compromise (BEC) average loss in pharma: $1.2M per incident
- Time to detect phishing breach: Average 213 days
- Spear-phishing success rate against pharma employees: 12-15% (without training), 2-3% (with training)

## Supply Chain Attacks

### Overview
Pharma companies rely on complex supply chains of vendors, CROs, CDMOs, distributors, and IT providers. Attacks on these intermediaries cascade to pharma companies.

### Notable Supply Chain Vectors
- Software supply chain: NotPetya via MeDoc update (Merck), SolarWinds affecting pharma customers, MOVEit Transfer exploitation (2023)
- CRO/CDMO compromise: Attacks on contract research and manufacturing organizations expose multiple pharma clients simultaneously
- Cloud service provider compromise: APT10 Cloud Hopper targeting MSPs serving pharma
- Pharmacy benefit manager (PBM) attacks: Change Healthcare disrupted the entire US pharmacy claims system
- Cold chain logistics: Attacks on pharmaceutical shipping and temperature-controlled logistics
- Medical device supply chain: Compromised medical devices as entry points to pharma networks

### Supply Chain Attack Costs
- Average cost of supply chain attack affecting pharma: $11.8M (includes cascading effects)
- NotPetya supply chain impact on pharma alone: $2B+ across Merck, Nuance, logistics providers
- Change Healthcare supply chain impact: $2.87B+ (UnitedHealth alone), estimated $10B+ across affected pharmacies and providers

## Data Breaches and Exfiltration

### Types of Pharma Data Targeted
- Patient data: PII, PHI, prescription records, clinical trial participant data
- Intellectual property: Drug formulations, synthesis routes, clinical trial protocols and results
- Regulatory submissions: NDA/BLA filings, FDA correspondence, approval strategies
- Manufacturing data: Process parameters, quality control data, batch records
- Financial data: M&A plans, pricing strategies, revenue forecasts
- Employee data: Credentials, personal information, security clearances

### Data Breach Statistics in Pharma
- Average cost per stolen healthcare/pharma record: $614 (2024, highest of any industry)
- Average pharma data breach cost: $10.93M (2024)
- Average records compromised per pharma breach: 3.2M
- Percentage involving patient data: 67%
- Percentage involving IP theft: 23%
- Time to identify breach: 194 days average
- Time to contain breach: 69 days average

## Industrial Control System (ICS) / OT Attacks

### Overview
Pharma manufacturing relies on Operational Technology (OT) systems including SCADA, DCS, and programmable logic controllers. These systems control drug production, quality, and safety.

### Pharma OT Attack Vectors
- IT/OT convergence: Ransomware spreading from IT networks to manufacturing OT systems
- Direct OT targeting: Snake/EKANS ransomware specifically designed to kill ICS processes
- Supply chain: Compromised vendor remote access to OT systems
- Insider threat: Disgruntled employees with OT access

### Pharma OT Attack Impacts
- Production shutdown: Average 14 days of lost production per OT incident
- Batch loss: Entire production batches may need to be destroyed ($1-50M per batch depending on drug)
- Regulatory: FDA may require re-validation of manufacturing processes after OT compromise
- Drug shortage: Extended shutdowns can cause drug shortages affecting patient care
- GMP compliance: Any unauthorized change to OT systems may violate GMP requirements

## Insider Threats

### Overview
Insider threats account for approximately 20% of pharma security incidents. High-value IP and regulatory data make insiders a significant risk.

### Types of Pharma Insider Threats
- IP theft by departing employees: Drug formulations, research data, client lists
- Sabotage: Disgruntled employees tampering with manufacturing or data systems
- Credential sharing: Bypassing access controls in labs and manufacturing
- Unintentional insiders: Employees falling for phishing, misconfiguring systems
- Third-party insiders: Contractor and vendor employees with system access

### Insider Threat Statistics in Pharma
- 20% of pharma security incidents involve insiders
- Average cost of insider incident in pharma: $15.4M
- Time to contain insider threat: 85 days average
- 60% of IP theft occurs within 30 days of employee resignation notice
