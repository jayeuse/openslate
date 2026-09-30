# Outpatient clinic reference model for OpenSlate simulation

Model the clinic as 7 departments and 27 modules. Clinical statuses use the FHIR R4 codes. Billing uses the X12 claim adjustment reason codes (CARC) for denials, plus payer-specific states such as PhilHealth "return to hospital". Run one quarter (October to December, which includes the Northern Hemisphere flu season). Clinical records are a sampled slice of real traffic; operational records are full volume. The total is 6,178 records.

Tags: **[judgment]** means my own practitioner judgment, not a source. **[summary]** means the claim came from a search-result summary and I did not read the primary page.

## 1. Reference organization profile

| Attribute | Value | Basis |
|---|---|---|
| Providers | 12 physicians (6 family/internal medicine, 2 pediatrics, 1 OB-GYN, 1 cardiology, 1 dermatology, 1 ENT) + 3 NPs/PAs | Your range; specialty mix [judgment] |
| Staff | About 70 (about 4.7 per physician) | MGMA staffing benchmarks vary widely by ownership model [18][summary] |
| Visits per day | About 250–270 (about 18 per provider) | About 20 visits a day per provider; the AAFP worked example uses 24 [17] |
| Primary care panel | About 1,800–2,300 per PCP; about 13,000 active patients | AAFP example: ideal panel of 1,806 at 3.19 visits per patient per year [17] |
| Payers | 10–14 contracts: 1 national/public scheme, 5–8 private insurers/HMOs, 2–3 corporate accounts, plus self-pay | [judgment] |
| Lab menu | About 60 in-house tests (hematology, chemistry, urinalysis, rapid tests) + about 200 send-outs to a reference lab | [judgment]; PhilHealth Konsulta's primary-care lab list is a minimum core [26][summary] |
| Pharmacy | About 300–400 SKUs, about 140 fast movers, lot and expiry tracked | [judgment] |

**Daily operation [judgment]:**
- Fasting labs start at 07:00 and clinics at 08:00.
- Patients check in, then a nurse or medical assistant (MA) triages them.
- Providers see the patients and place orders, referrals and prescriptions.
- The lab runs routine tests the same day. A courier takes send-outs at about 15:00.
- The in-house dispensary fills about 60% of prescriptions.
- Claims go out in daily batches.

**Regional differences:**
- **US:** Office visits use E/M codes 99202–99215 [35] and ICD-10-CM diagnosis codes. Payers explain denials with CARC codes [22]. Medicare's filing limit is 12 months [23].
- **Philippines:** Company-paid HMO cards are common at private clinics. PhilHealth Konsulta covers primary care, a list of lab tests and maintenance medicines [26]. PhilHealth claims must be filed within 60 days [24]. Incomplete claims come back as "Return to Hospital" (RTH) [25].
- **UK/NHS-like:** There is no claim for each visit. Replace the claim modules with private or self-pay invoices only. Use "DNA" (did not attend) in place of no-show.

## 2. Departments

| Department | Purpose | Lead / staff |
|---|---|---|
| Patient Access | Registration, scheduling, check-in, coverage checks, cashiering | Front Office Supervisor / Patient Service Representatives (PSRs, 6–8), Call Center Agents (3), Cashiers (2) |
| Clinical Services | Triage, encounters, orders, prescriptions, referrals | Medical Director / Physicians, NPs/PAs, Charge Nurse, RNs (6), Medical Assistants (10), Referral Coordinator |
| Laboratory | Specimen collection, testing, quality control (QC), result release | Laboratory Manager (a medical technologist; pathologist as consultant) / Medical Technologists (MTs, 4), Phlebotomists (2), Lab Aide |
| Pharmacy | Dispensing, inventory, cold chain | Pharmacist-in-Charge / Staff Pharmacist, Pharmacy Assistants (3) |
| Revenue Cycle | Coding, claims, denials, payment posting | Billing Manager / Medical Coders (2), Claims Specialists (3), Payment Poster, Credit and Collections Officer |
| Operations & Supply | Purchasing, receiving, equipment, facilities | Operations Manager / Purchasing Officer, Storekeeper, Biomedical Technician (contract), Maintenance Staff |
| Quality & Compliance | Incidents, infection control, credentialing, privacy | Quality & Compliance Officer (also Data Protection Officer) / Infection Prevention Nurse, Credentialing Specialist, HR Officer |

The Practice Administrator and the IT administrator are the OpenSlate admins.

## 3. Core processes

**Appointment to encounter**
1. A PSR or call agent books the visit. The `Appointment` status is booked.
2. The day before, the call agent sends a reminder and records the confirmation.
3. At arrival, the PSR sets the status to arrived, checks `Coverage`, collects the copay (`Payment`), and sets the status to checked-in.
4. The MA triages the patient: `Encounter` status goes arrived → triaged, with vitals and chief complaint.
5. The provider sees the patient: in-progress → finished, with a brief note, a diagnosis and a disposition.
6. The PSR checks the patient out. The Appointment status becomes fulfilled.

This follows the FHIR appointment and encounter statuses [1][2]. It also matches OpenEMR's patient flow statuses: Arrived, In exam room, Checked out, Coding done [14].

**Order to result**
1. The provider creates an `Order` (a FHIR ServiceRequest, status active, priority routine/urgent/asap/stat [5]).
2. The phlebotomist collects the specimen and creates a `Specimen` record with an accession number.
3. The MT receives the specimen, or rejects it as unsatisfactory [6], and runs the test.
4. The MT enters the `Lab Result` as preliminary. A second MT or the lab manager validates it to final [8]. Bahmni/OpenELIS uses the same accession-then-validate step [16].
5. The Order becomes completed, and the provider reviews the result.

**Prescribe to dispense**
1. The provider creates a `Prescription` (FHIR MedicationRequest, status active [9]).
2. The pharmacist checks it.
3. The pharmacy assistant picks from the `Stock Lot` that expires first.
4. The `Dispense` goes preparation → in-progress (ready for pickup) → completed at pickup [10]. The lot quantity goes down.
   - Exception states: declined, on-hold (stock-out or a question to the prescriber), cancelled (never collected).

**Encounter to claim to payment**
1. The coder assigns the ICD-10 and procedure codes.
2. The claims specialist creates a `Claim` (draft → submitted) with the charge total and the Coverage [11].
3. The payer returns a `Claim Response` with an outcome (complete, partial or error [12]), a decision, the paid amount and a CARC reason [22].
4. The payment poster records the payer remittance and the patient's share as `Payment` records.
5. For a denial, the claims specialist corrects and resubmits, appeals, or writes off the claim.

**Procure to pay**
1. A storekeeper or pharmacist raises a `Purchase Request`.
2. The Operations Manager approves it.
3. The Purchasing Officer sends a `Purchase Order` to a `Supplier`.
4. The storekeeper records a `Goods Receipt` with lot numbers and expiry dates. Pharmacy items get `Stock Lot` records.
5. Finance matches the invoice against the PO and the receipt, then pays [judgment].

**Incident to review**
1. Any staff member files an `Incident Report` (status reported).
2. The Quality Officer sets the incident type and harm level from the WHO patient safety classification (ICPS) [31]. The status becomes under review.
3. A severe or sentinel event gets a root-cause analysis (RCA) and an action plan.
4. The Quality Officer closes the incident. The monthly quality meeting reviews trends.

## 4. Modules (27)

Format: `Field (Type, req)`. Every module also has its creator and timestamps. Links to Patient are relationships, not fields.

**Patient Access**
1. **Patient:** MRN (Text, req); Given name (Text, req); Family name (Text, req); Date of birth (Date, req); Sex (Select: female, male, other, unknown [FHIR AdministrativeGender], req); Mobile (Text); Email (Email); City (Text); Payer class (Select: self-pay, private insurance/HMO, national scheme, corporate, req); SMS consent (Checkbox); Record status (Select: active, inactive, merged, entered-in-error, req).
2. **Coverage** [13]: Member ID (Text, req); Plan/Group (Text); Relationship to subscriber (Select: self, spouse, child, other); Valid from (Date); Valid to (Date); Copay amount (Number); Eligibility (Select: not checked, eligible, not eligible, needs LOA/authorization); Status (Select: draft, active, cancelled, entered-in-error, req).
3. **Payer:** Name (Text, req); Type (Select: national scheme, private insurer, HMO, corporate account, government program, req); Payer ID (Text); Claims portal (URL); Filing limit days (Integer); Status (Select: active, inactive).
4. **Appointment** [1][14]: Appointment no. (Text, req); Start (Date/Time, req); Duration min (Integer); Visit type (Select, req); Provider (User, req); Booked via (Select: phone, walk-in, portal, staff); Reminder (Select: not sent, confirmed, callback requested, no answer); Cancel reason (Select: patient request, cancelled <24h, provider unavailable, left without visit, duplicate); Status (Select: waitlist → booked → arrived → checked-in → fulfilled | cancelled, noshow, entered-in-error, req).
5. **Payment:** Receipt no. (Text, req); Paid at (Date/Time, req); Amount (Number, req); Source (Select: patient, payer remittance, req); Method (Select: cash, card, bank transfer, e-wallet, payer EFT, check); Reference no. (Text); Received by (User, req); Status (Select: posted, pending, refunded, voided, req).

**Clinical Services**

6. **Encounter** [2]: Encounter no. (Text, req); Start (Date/Time, req); Billing class (Select: self-pay, insured, corporate, national scheme, req); Visit type (Select); Chief complaint (Text, req); BP systolic / diastolic (Integer); Temperature °C (Number); Primary diagnosis ICD-10 (Text); Note (Long text); Disposition (Select: home, follow-up booked, referred, sent to ED); Provider (User, req); Status (Select: planned → arrived → triaged → in-progress → finished | cancelled, entered-in-error, req).
   - Billing class is copied from the Patient at check-in, because automation conditions read only the same record.
   - FHIR R5 renames these statuses: finished becomes completed, and it adds discharged, discontinued and on-hold [3]. Use one version only.
7. **Order** [4][5]: Order no. (Text, req); Category (Select: laboratory, imaging, procedure, req); Test/service (Text, req); Priority (Select: routine, urgent, asap, stat, req); Reason ICD-10 (Text); Fasting required (Checkbox); Performer (Select: in-house lab, reference lab, external imaging); Requester (User, req); Status (Select: draft → active → completed | on-hold, revoked, entered-in-error, req).
8. **Referral** (FHIR ServiceRequest, category referral): Referral no. (Text, req); Specialty (Select, req); Referred to (Text); Urgency (Select: routine, urgent); Reason (Text, req); Authorization no. (Text); Report received (Checkbox); Status (Select: draft → active (sent) → completed | on-hold (awaiting authorization), revoked, entered-in-error, req).
9. **Prescription** [9]: Rx no. (Text, req); Medication (Text, req); Strength/form (Text, req); Dose instructions (Text, req); Quantity (Integer, req); Refills (Integer); Fill at (Select: in-house, external); Prescriber (User, req); Status (Select: draft → active → completed | on-hold, cancelled, stopped, entered-in-error, req).

**Laboratory**

10. **Specimen** [6]: Accession no. (Text, req); Type (Select: whole blood EDTA, serum, plasma, urine, stool, throat swab, nasopharyngeal swab, sputum, req); Collected at (Date/Time); Collector (User); Fasting (Checkbox); Rejection reason (Select: hemolyzed, clotted, QNS, unlabeled/mislabeled, wrong tube, delayed transport); Status (Select: awaiting collection → collected → received → available | unsatisfactory, unavailable, entered-in-error, req).
    - Only available, unavailable, unsatisfactory and entered-in-error are FHIR codes. The pre-collection and receiving states are workflow additions.
11. **Lab Result** [7][8]: Report no. (Text, req); Test (Text, req); Result value (Text, req); Units (Text); Reference range (Text); Flag (Select: normal, low, high, critical low, critical high, abnormal); Critical call-back (Select: not needed, pending, done); Performed by (User, req); Validated by (User); Status (Select: registered → preliminary → final | amended, corrected, cancelled, entered-in-error, req).
12. **Lab QC Run:** Run date (Date, req); Analyzer (Text, req); Level (Select: level 1, level 2, level 3); Analyte (Text); Rule violated (Select: none, 1-2s warning, 1-3s, 2-2s, R-4s, 10x); Corrective action (Long text); Performed by (User, req); Status (Select: pending → passed | failed → repeated-passed, req).
    - The rule names are the standard Westgard QC rules [judgment].

**Pharmacy**

13. **Dispense** [10]: Dispense no. (Text, req); Quantity (Integer, req); Lot no. (Text, req); Days supply (Integer); Counselled (Checkbox); Dispensed by (User, req); Verified by (User, pharmacist); Status (Select: preparation → in-progress → completed | on-hold, declined, cancelled, stopped, entered-in-error, req).
14. **Pharmacy Item:** Item code (Text, req); Generic name (Text, req); Strength (Text, req); Form (Select: tablet, capsule, syrup, suspension, inhaler, cream/ointment, injection, sachet); Unit price (Number, req); Reorder level (Integer); Cold chain (Checkbox); Status (Select: active, inactive, discontinued).
15. **Stock Lot:** Lot no. (Text, req); Expiry date (Date, req); Qty on hand (Integer, req); Unit cost (Number); Location (Select: dispensary shelf, fridge 1, fridge 2, stockroom); Status (Select: available, quarantined, expired, recalled, depleted, req).
16. **Temperature Log** [30]: Unit (Select: vaccine fridge 1, pharmacy fridge 2, lab fridge, req); Check time (Date/Time, req); Shift (Select: AM, PM); Current °C (Number, req); Min °C (Number); Max °C (Number); Checked by (User, req); Status (Select: in range, excursion, excursion resolved, req).

**Revenue Cycle**

17. **Claim** [11]: Claim no. (Text, req); Service date (Date, req); ICD-10 codes (Text, req); Procedure codes (Text); Charge total (Number, req); Submitted on (Date); Resubmission count (Integer); Work queue (Select: none, denials, RTH corrections, appeals); Claim specialist (User); Status (Select: draft → submitted → pending → paid | partially paid, denied, returned for correction, resubmitted, appealed, written off, entered-in-error, req).
    - FHIR Claim.status has only active, cancelled, draft and entered-in-error. The other states are a workflow layer on top.
18. **Claim Response** [12][22]: Response no. (Text, req); Received on (Date, req); Outcome (Select: queued, complete, partial, error [FHIR], req); Decision (Select: approved, partially approved, denied, returned for correction, req); Allowed amount (Number); Paid amount (Number); Patient responsibility (Number); Reason code CARC (Select: 16, 18, 22, 27, 29, 31, 45, 50, 96, 97, 109, 167, 197, 204, 252); Remark (Long text).

**Operations & Supply**

19. **Supplier:** Name (Text, req); Category (Select: pharmaceuticals, lab reagents, medical supplies, equipment service, office); Contact email (Email); Lead time days (Integer); Accredited/licensed (Checkbox); Status (Select: active, on hold, inactive).
20. **Purchase Request:** PR no. (Text, req); Item (Text, req); Qty (Integer, req); Needed by (Date); Reason (Select: reorder level, new item, stock-out, project); Requested by (User, req); Approver (User); Status (Select: draft → submitted → approved → converted to PO | rejected, cancelled, req).
21. **Purchase Order:** PO no. (Text, req); Order date (Date, req); Total (Number, req); Expected delivery (Date); Invoice no. (Text); Invoice matched (Checkbox); Approved by (User, req); Status (Select: draft → approved → sent → partially received → received → closed | cancelled, req).
22. **Goods Receipt:** GR no. (Text, req); Received at (Date/Time, req); Qty received (Integer, req); Qty rejected (Integer); Lot no. (Text); Expiry (Date); Received by (User, req); Status (Select: received → accepted | partially rejected, rejected, req).
23. **Equipment:** Asset tag (Text, req); Name (Text, req); Make/model (Text); Serial no. (Text); Location (Text); Calibration required (Checkbox); Next PM due (Date); Status (Select: in service, due for service, out of service, under repair, retired, req).
24. **Maintenance Work Order:** WO no. (Text, req); Type (Select: preventive maintenance, calibration, corrective repair, electrical safety test, req); Scheduled (Date); Completed (Date); Result (Select: pass, adjusted then pass, fail); Technician (Text); Cost (Number); Status (Select: open → scheduled → in progress → completed | awaiting parts, cancelled, req).

**Quality & Compliance**

25. **Incident Report** [31]: Incident no. (Text, req); Occurred at (Date/Time, req); Type (Select: clinical administration, clinical process/procedure, documentation, healthcare-associated infection, medication, medical device/equipment, behaviour, patient accident, infrastructure, resources/organisational management, staff injury, privacy breach, cold chain, req); Harm (Select: near miss, no harm, mild, moderate, severe, death, req); Location (Text); Summary (Long text, req); Patient MRN (Text); Review level (Select: department review, RCA required); Handler (User); Status (Select: reported → under review → action plan → closed, req).
26. **Infection Control Audit:** Audit date (Date, req); Type (Select: hand hygiene, environmental cleaning, sharps disposal, sterilization log, PPE, req); Area (Text); Opportunities observed (Integer); Compliant (Integer); Score % (Number); Auditor (User, req); Status (Select: scheduled → completed → closed | follow-up required, req).
27. **Staff Credential** [33]: Credential type (Select: medical license, nursing license, pharmacist license, medtech license, controlled-drug registration, BLS/ACLS, board certification, malpractice insurance, payer enrollment, req); Staff member (User, req); License no. (Text, req); Issued (Date); Expires (Date, req); Primary source verified (Checkbox); Privileges active (Checkbox); Status (Select: pending verification → verified → expiring soon → renewed | expired, suspended, revoked, req).

## 5. Relationships

| From → To | Cardinality | Reason |
|---|---|---|
| Patient → Coverage | 1:N | A patient can have a primary and a secondary plan |
| Payer → Coverage | 1:N | Each plan belongs to one payer |
| Patient → Appointment | 1:N | Scheduling history |
| Appointment → Encounter | 1:1 | A booked visit becomes one encounter; walk-ins have no appointment |
| Patient → Encounter | 1:N | Long-term record |
| Encounter → Order | 1:N | Orders are placed during a visit |
| Order ↔ Specimen | N:M | One tube serves several tests; a test can need a new sample |
| Order → Lab Result | 1:N | Results and amended reports |
| Specimen → Lab Result | 1:N | Shows which sample a result came from |
| Encounter → Referral | 1:N | Specialist referrals |
| Encounter → Prescription | 1:N | One record per drug |
| Prescription → Dispense | 1:N | Partial fills and refills |
| Stock Lot → Dispense | 1:N | Lot tracing for recalls |
| Pharmacy Item → Stock Lot | 1:N | Lot and expiry per item |
| Encounter → Claim | 1:N | Usually one; a secondary payer adds a second claim |
| Coverage → Claim | 1:N | Payer and member on the claim |
| Claim → Claim Response | 1:N | Each resubmission gets a new decision |
| Claim → Payment | 1:N | Payer remittance and patient share |
| Patient → Payment | 1:N | Copays and self-pay |
| Supplier → Purchase Order | 1:N | Supplier history |
| Purchase Request ↔ Purchase Order | N:M | Several PRs are combined into one PO |
| Purchase Order → Goods Receipt | 1:N | Partial deliveries |
| Goods Receipt → Stock Lot | 1:N | Receiving creates lots |
| Equipment → Maintenance Work Order | 1:N | Service history |
| Equipment → Lab QC Run | 1:N | QC per analyzer |
| Equipment → Temperature Log | 1:N | Log per fridge |
| Incident Report ↔ Equipment | N:M | Device-related incidents |

## 6. Automations

Two model limits shape these rules:
- Conditions compare fields only to fixed values, and there is no formula type. So a rule cannot say "expires within 30 days" or "below this item's own reorder level". The rules use one fixed threshold for the whole module, or a schedule.
- Each rule has one action, and the action either changes the same record or creates a new record.

| # | Event | Condition | Action |
|---|---|---|---|
| 1 | Encounter field-changed Status | Status = finished AND Billing class ≠ self-pay | Create Claim (Status draft) |
| 2 | Order record-created | Category = laboratory AND Performer = in-house lab | Create Specimen (Status awaiting collection) |
| 3 | Specimen field-changed Status | Status = unsatisfactory | Create Specimen (awaiting collection, "Recollection") |
| 4 | Lab Result field-changed Flag | Flag = critical high OR critical low | Set Critical call-back = pending |
| 5 | Prescription record-created | Fill at = in-house | Create Dispense (Status preparation) |
| 6 | Stock Lot threshold-crossed Qty on hand | Falls below 20 | Create Purchase Request (Status draft, Reason reorder level) |
| 7 | Schedule daily 07:30 | None | Create Temperature Log (Unit vaccine fridge 1, Shift AM) [30] |
| 8 | Temperature Log threshold-crossed Max °C | Rises above 8 | Set Status = excursion |
| 9 | Temperature Log field-changed Status | Status = excursion | Create Incident Report (Type cold chain, Harm no harm) |
| 10 | Equipment field-changed Status | Status = out of service | Create Maintenance Work Order (Type corrective repair, Status open) |
| 11 | Claim field-changed Status | Status = denied | Set Work queue = denials |
| 12 | Incident Report record-created | Harm = severe OR death | Set Review level = RCA required |

Notes on the rules:
- Rule 1: if conditions allow only "equals", make one rule for each insured billing class.
- Rule 7: add a second rule at 16:30, and a pair of rules for each fridge.
- Rule 8: add a sister rule for Min °C falling below 2.
- Rules 4 and 12: if conditions allow only AND, split each into two rules.
- Other candidate rules:
  - A no-show Appointment sets Reminder to callback requested.
  - An expired Staff Credential sets Privileges active to false.
  - A daily 07:00 schedule creates a pending Lab QC Run.

## 7. Volumes: one quarter (13 weeks, 64 working days), total 6,178

A real clinic of this size has about 17,000 encounters a quarter, which is already over the 6,000-record budget. So the simulation samples about 3% of clinical traffic (about 8 encounters per working day) and keeps the real ratios between modules. Operational modules run at full volume, so their daily and weekly rhythms stay realistic. A script checked the totals.

| Module | Count | How it is derived |
|---|---|---|
| Appointment | 620 | Sample base |
| Encounter | 536 | 73.5% of appointments fulfilled or in progress, ÷ 0.85 because walk-ins are 15% of encounters [judgment] |
| Patient | 462 | 536 ÷ 1.3 visits per patient per quarter, + 50 patients who only no-showed |
| Coverage | 360 | 78% of patients insured [judgment] |
| Order | 295 | 0.55 per encounter: lab 266, imaging 29 [judgment] |
| Specimen | 200 | 0.75 per lab order, because tests share tubes |
| Lab Result | 247 | 93% of lab orders get a result |
| Prescription | 482 | 0.9 drug lines per encounter [judgment] |
| Dispense | 289 | 60% filled in-house |
| Referral | 32 | 6% of encounters |
| Claim | 375 | 70% of encounters billed to a payer |
| Claim Response | 360 | 88% of claims decided, + 30 second responses after resubmission |
| Payment | 552 | 0.75 patient payments per encounter, + 150 payer remittances |
| Payer | 12 | Contracts |
| Pharmacy Item | 140 | Fast movers |
| Stock Lot | 210 | 1.5 lots per item |
| Lab QC Run | 192 | 3 levels × 64 days |
| Temperature Log | 256 | 2 fridges × 2 checks × 64 days [30] |
| Supplier | 24 | |
| Purchase Request | 70 | About 5 a week |
| Purchase Order | 52 | |
| Goods Receipt | 48 | |
| Equipment | 65 | |
| Maintenance Work Order | 85 | Quarterly maintenance batch + ad hoc repairs |
| Incident Report | 28 | About 2 a week [judgment] |
| Infection Control Audit | 26 | 2 a week |
| Staff Credential | 160 | About 2 per staff member |

**Key ratios:**
- **No-show rate 11%.** A US VA outpatient study found 18.8% [19], and primary care is often about 10%. NHS GP practices record about 4–5% DNA [20][summary]. For a UK variant, use about 5%.
- **Cancellations 9%.** One third of them are late (under 24 hours), which matches OpenEMR's separate "Canceled < 24h" status [14].
- **First-pass denial rate 8%.** This is MGMA's benchmark, and many groups report that denials are rising [21].
- **Specimen rejection 1%.** Outpatient labs run about 0.3%, and the pooled rate across labs is 2% [32]. I chose 1% so that some rejections appear in the data.

## 8. Status distribution at the snapshot (last day of the quarter) and changes over time

| Module | Status mix at the snapshot | Changes during the run |
|---|---|---|
| Appointment | fulfilled 72%, noshow 11%, cancelled 9%, booked (future) 6%, checked-in/arrived 1.5%, entered-in-error 0.5% | Seen visits go booked → arrived → checked-in → fulfilled in the same session; 6% are still booked at the end |
| Encounter | finished 97%, in-progress/triaged 2%, entered-in-error 1% | Each goes arrived → triaged → in-progress → finished within 20–90 minutes |
| Order | completed 88%, active 8%, revoked 3%, entered-in-error 1% | In-house lab orders complete in 0–3 days, send-outs in 2–5 days, imaging in 3–10 days |
| Specimen | available 85%, received/collected 13%, unsatisfactory 1%, unavailable 1% | All change status within 1 day |
| Lab Result | final 88%, preliminary 8%, amended/corrected 2%, cancelled 2% | About 10% go preliminary → final the next day; 2% are corrected later |
| Prescription | active 55% (refills pending), completed 38%, stopped 4%, cancelled 2%, entered-in-error 1% | 30% go active → completed within the quarter |
| Dispense | completed 90%, in-progress (awaiting pickup) 4%, declined 3%, cancelled 2%, on-hold 1% | 5% wait 1–7 days for pickup; fills not collected by day 7 are cancelled [judgment] |
| Claim | paid 70%, partially paid 8%, pending/submitted 12%, denied 5%, resubmitted/returned 3%, written off 1%, draft 1% | Private payers pay in 14–30 days [judgment]; PhilHealth takes up to 60 days [24]. 8% are denied first time, and 60% of those are resubmitted and paid |
| Claim Response | complete 88%, partial 9%, error 3% | Does not change after creation |
| Payment | posted 96%, pending 2%, refunded 1%, voided 1% | |
| Purchase Request | converted 70%, approved 10%, submitted 8%, rejected 7%, cancelled 5% | Approved within 1–3 days |
| Purchase Order | closed 65%, received 15%, sent 12%, partially received 8% | Received within 3–14 days |
| Maintenance Work Order | completed 82%, scheduled 10%, awaiting parts 5%, open 3% | |
| Temperature Log | in range 98%, excursion resolved 1.5%, excursion 0.5% | |
| Lab QC Run | passed 95%, repeated-passed 4%, failed 1% | |
| Incident Report | closed 60%, action plan 15%, under review 15%, reported 10% | Closed within 2–6 weeks |
| Staff Credential | verified 85%, expiring soon 8%, renewed 4%, pending 2%, expired 1% | 4–6 credentials renew during the quarter |

## 9. Content vocabulary (all invented)

**Identifier formats** [judgment, styled on OpenMRS, OpenEMR and Bahmni; the year 2025 is only an example]:
- MRN: `0104827-K`, numbers plus a check character, like OpenMRS's Luhn mod-30 check digit [15][summary].
- Appointment: `APT-251014-037`.
- Encounter: `ENC-2025-018443`.
- Lab accession: `L2510140023`, generated at collection as in Bahmni [16].
- Prescription: `RX-25-09312`.
- Claim: `CLM-25-004812`.
- Other records: `PO-2025-0311`, `IR-25-017`, `EQ-LAB-004`.

**Invented patient names:** Marisol Dantes, Kieran Holloway, Aiyana Brooks, Tomasz Wren, Liza Macaraeg, Oren Castell, Priya Venkat, Benedikt Sorell, Noemi Arceo, Dario Pellham, Yuki Tanabe, Celeste Omondi, Rafael Ibarrola, Hattie Lindqvist, Joaquin Sevilla.

**Visit types:** new patient, follow-up, annual physical, acute/same-day, chronic disease review, well-child, prenatal, pre-employment medical, vaccination, lab-only, results review, telehealth follow-up, minor procedure, specialist consult.

**Chief complaints with ICD-10 codes:** The codes are in ICD-10-CM form. WHO ICD-10 differs for some of them, for example M54.5 and R51. I did not check each code one by one in this session [36].

| Chief complaint | Code |
|---|---|
| Cough and colds x3 days | J06.9 |
| Sore throat | J02.9 |
| Fever with body aches | J11.1 in flu season, otherwise B34.9 |
| BP follow-up | I10 |
| Diabetes follow-up | E11.9 |
| Cholesterol review | E78.5 |
| Burning urination | N39.0 |
| Epigastric pain | K29.70 |
| Low back pain | M54.50 |
| Headache | R51.9 |
| Itchy rash | L30.9 |
| Red eye | H10.9 |
| Loose stools | A09 |
| Wheezing | J45.909 |
| Annual physical | Z00.00 |
| Flu shot | Z23 |
| Fever x2 days (tropical season) | Rule out A90 (dengue) |

**Lab tests:** CBC with platelet count, urinalysis, fecalysis, fasting blood sugar, HbA1c, lipid profile, creatinine, BUN, ALT/SGPT, uric acid, potassium, TSH, urine pregnancy test, rapid strep antigen, influenza A/B rapid antigen, dengue NS1 antigen, blood typing, sputum AFB smear, fecal occult blood, OGTT. Many of these are on PhilHealth Konsulta's list [26].

**Medications (generic name, strength, form):** amlodipine 5 mg tab, losartan 50 mg tab, hydrochlorothiazide 25 mg tab, metoprolol 50 mg tab, metformin 500 mg tab, gliclazide 80 mg tab, atorvastatin 20 mg tab, amoxicillin 500 mg cap, co-amoxiclav 625 mg tab, azithromycin 500 mg tab, cefalexin 500 mg cap, nitrofurantoin 100 mg cap, paracetamol 500 mg tab, ibuprofen 400 mg tab, cetirizine 10 mg tab, salbutamol 100 mcg inhaler, omeprazole 20 mg cap, oral rehydration salts sachet, mupirocin 2% ointment, influenza vaccine 0.5 mL prefilled syringe.

**Supply items:** nitrile gloves M (box of 100), 3 mL syringe with 23G needle, EDTA tube 3 mL lavender, serum separator tube 5 mL gold, sterile urine cup, alcohol prep pads, gauze 4x4, surgical masks (box of 50), N95 respirators, sharps container 5 L, glucose test strips, HbA1c test cartridges, ECG electrodes, exam table paper roll, alcohol hand rub 500 mL, disinfectant wipes, tongue depressors, biohazard specimen bags, barcode labels for the specimen printer.

**Claim denial reasons** (CARC meanings, shortened [22]):
- 16: claim lacks information
- 18: exact duplicate
- 22: another payer may cover this (coordination of benefits)
- 27: coverage had ended
- 29: filing time limit expired
- 31: patient not found as an insured member
- 45: charge is above the fee schedule
- 50: not medically necessary
- 97: included in payment for another service
- 109: wrong payer
- 167: diagnosis not covered
- 197: authorization missing
- 204: not covered under the patient's plan
- 252: attachment required
- PhilHealth: RTH for unreadable attachments (CF4, SOA or CSF forms [25]), and late filing after 60 days [24].

**Incident examples:**
- Patient slipped on a wet floor in the waiting area.
- Specimen tube arrived without a label.
- Wrong strength picked, caught at the counter (near miss).
- Vaccine fridge at 9.4 °C at the morning check.
- Needlestick while recapping a needle.
- Lab result filed to the wrong chart.
- Referral letter emailed to the wrong address (privacy).
- Patient shouted at the cashier.
- BP monitor showed an error during triage.
- Expired lot found on the shelf.
- Hand-rub dispenser empty in Room 4.
- Patient left without being seen after a 90-minute wait.

**Notes as staff write them (short and generic):**
- "CC: cough x3d, no fever. Advised fluids, rest. RTC if worse."
- "BP 142/90 on recheck. Cont meds, f/u 4 wks."
- "Labs ordered: CBC, FBS. Pt to return fasting."
- "Refilled maintenance meds x30d."
- "Referred to ENT, routine."
- "Pt NS x2, SMS sent." (NS means no-show)
- "Called pt re: critical K+, advised ED. Documented."
- "Hemolyzed, recollect requested."
- "Claim returned: missing CF4. Refiled."
- "Denied CO-197, LOA requested from HMO."
- "Fridge 1 excursion 45 min, vaccines quarantined, mfr contacted."

These notes are only examples of style. They are not clinical guidance.

## 10. Board content over a quarter [judgment]

| Department | Announcements | Calendar events |
|---|---|---|
| Clinical | Flu vaccine clinic opens Oct 6; new triage vitals procedure; holiday on-call roster | Flu vaccination drive (Saturdays, Oct–Nov), monthly clinical meeting, BLS refresher |
| Patient Access | New steps for checking HMO cards; holiday hours; no-show callback script | Holiday closures (Dec 25, Jan 1), weekly huddle Monday 07:45 |
| Laboratory | Dengue NS1 kit lot change; reference-lab courier moved to 15:30; critical-value list updated | Proficiency testing submission, analyzer maintenance visit, monthly QC review |
| Pharmacy | Salbutamol inhaler backorder, with a substitute listed; recall notice for one lot; year-end stock count | Quarterly stock count (Dec 28), monthly expiry sweep |
| Revenue Cycle | Payer fee schedules change Jan 1; PhilHealth 60-day filing reminder; top 5 denials this month | Month-end close, payer reconciliation meeting |
| Operations | Generator test; equipment maintenance schedule; new glove supplier | Fire drill, quarterly maintenance week, supplier review |
| Quality | Hand-hygiene score 86% against a 90% target; Q3 incident trends; privacy refresher due | Monthly quality committee, infection-control walk-round, mock accreditation survey |

## 11. Access design and planned refusals

Privacy law and minimum-necessary access:
- Health data is a special category under the GDPR [28]. It is also sensitive personal information under the Philippine Data Privacy Act (RA 10173 §3(l)) [29].
- The GDPR allows health data to be used for care by professionals who have a duty of confidentiality.
- The HIPAA "minimum necessary" rule requires role-based policies that say which groups of staff can see which kinds of health information [27][summary].
- Sharing with providers for treatment is exempt from that rule.

The groups below apply these rules module by module.

| Group | Manage | Write | Read | No access |
|---|---|---|---|---|
| Front Desk | Appointment | Patient, Coverage, Payment | Payer | Encounter, Order, Lab Result, Specimen, Prescription, Claim |
| Clinicians | None | Encounter, Order, Referral, Prescription, Purchase Request | Patient, Coverage, Lab Result, Specimen, Dispense | Claim, Payment, other purchasing modules |
| Laboratory | Lab QC Run | Specimen, Lab Result | Order, Patient | Encounter, Prescription, Claim |
| Pharmacy | Pharmacy Item, Stock Lot | Dispense, Temperature Log, Purchase Request | Prescription, Patient, Lab Result | Encounter, Claim |
| Revenue Cycle | Claim, Claim Response | Payment, Coverage | Encounter, Patient, Payer | Lab Result, Prescription, Specimen |
| Operations | Supplier, Equipment, Purchase Order | Goods Receipt, Maintenance Work Order, Purchase Request | Temperature Log | All patient modules |
| Quality | Incident Report, Infection Control Audit, Staff Credential | None | Temperature Log, Maintenance Work Order | Clinical patient modules |
| Guest: external surveyor or auditor | None | None | Staff Credential, Infection Control Audit | Everything else |

Every group can write Incident Reports, so any staff member can file one. Access is set per module only. OpenSlate cannot limit Front Desk to patient payments inside the Payment module, so a written procedure covers that.

**Separation of duties:**
- The person who requests a purchase cannot approve the PO, because only Operations can write Purchase Orders.
- The MT who runs a test is not the one who validates it, as with Bahmni's lab-in-charge [16]. OpenSlate conditions cannot check "different user", so the data shows this through the Performed by and Validated by fields.
- The prescriber is not the dispenser.
- Revenue Cycle posts payments, and only the Billing Manager approves write-offs [judgment].

**Planned refusals:**

| # | Actor | Attempt | Why it is refused |
|---|---|---|---|
| 1 | PSR | Opens Lab Result when a patient asks "are my results out?" | Front Desk has no access, so the module is hidden |
| 2 | Claims Specialist | Edits an Encounter note to match a billing code | Revenue Cycle can only read Encounters |
| 3 | Medical Technologist | Changes a Prescription dose | Laboratory has no access to Prescriptions |
| 4 | Storekeeper | Searches Patient to deliver a special order | Operations has no access to patient modules |
| 5 | Medical Assistant | Creates a Purchase Order for gloves | Clinicians can write Purchase Requests but have no access to Purchase Orders |
| 6 | Pharmacy Assistant | Updates a Claim status after a patient complains | Pharmacy has no access to Claims |
| 7 | External auditor (guest) | Marks a Staff Credential as verified | Guests can only read |
| 8 | Nurse | Changes a Lab Result from preliminary to final | Clinicians can only read results; only the lab validates |

## 12. Cadences and seasonality

- **Daily:** fridge temperature checks, morning and afternoon [30]; analyzer QC before patient samples; reminder calls for the next day; claim batch; cash drawer close; courier pickup.
- **Weekly:** hand-hygiene audits, payer remittance posting, reorder review, denial work queue, staff huddle.
- **Monthly:**
  - Expiry sweep, quality committee, month-end close, review of unpaid balances by age.
  - Credential expiry check. Recredentialing is every 36 months [33][summary].
- **Quarterly:** preventive maintenance and calibration batch, stock count, incident trend report, review of fee schedules and payer contracts.

**Seasonality:**
- In the Northern Hemisphere, flu activity peaks from December to February [34]. From mid-November, raise respiratory visits (J06.9, J11.1) by about 30–40% [judgment].
- Raise flu rapid tests and vaccination visits in October and November, and lower all visits in holiday weeks [judgment].
- In tropical countries such as the Philippines, dengue and flu rise in the June–November rainy season [judgment]. For a Philippine clinic, move the NS1 and CBC volume to those months.
- Year-end brings annual physicals, pre-employment medicals, and patients using HMO benefits before they reset in January [judgment].

## 13. Sources

1. https://hl7.org/fhir/R4/valueset-appointmentstatus.html (FHIR R4 AppointmentStatus codes)
2. https://hl7.org/fhir/R4/valueset-encounter-status.html (FHIR R4 EncounterStatus)
3. https://hl7.org/fhir/R5/valueset-encounter-status.html (FHIR R5 EncounterStatus, renamed codes)
4. https://hl7.org/fhir/R4/valueset-request-status.html (RequestStatus, used by ServiceRequest)
5. https://hl7.org/fhir/R4/servicerequest.html (ServiceRequest intent and priority codes)
6. https://hl7.org/fhir/R4/specimen.html (Specimen status and elements)
7. https://hl7.org/fhir/R4/valueset-observation-status.html (ObservationStatus)
8. https://hl7.org/fhir/R4/valueset-diagnostic-report-status.html (DiagnosticReportStatus)
9. https://hl7.org/fhir/R4/valueset-medicationrequest-status.html (MedicationRequest status)
10. https://hl7.org/fhir/R4/valueset-medicationdispense-status.html (MedicationDispense status)
11. https://hl7.org/fhir/R4/claim.html (Claim status, use and elements)
12. https://hl7.org/fhir/R4/claimresponse.html (ClaimResponse outcome codes and adjudication categories)
13. https://hl7.org/fhir/R4/coverage.html (Coverage status and elements)
14. https://github.com/openemr/openemr/blob/master/sql/database.sql (OpenEMR default appointment statuses: arrived, in exam room, checked out, coding done, canceled <24h)
15. https://openmrs.atlassian.net/wiki/display/docs/Check+Digit+Algorithm (OpenMRS Luhn mod-N check digits) [summary]
16. https://bahmni.atlassian.net/wiki/spaces/BAH/pages/32014460/Using+Lab+Dashboard (Bahmni/OpenELIS accession and result validation) [summary]
17. https://www.aafp.org/pubs/fpm/issues/2007/0400/p44.html (AAFP panel-size formula: 3.19 visits per patient per year, 24 visits a day example)
18. https://www.mgma.com/articles/cost-efficiency-with-medical-group-staffing (MGMA staff per physician by ownership model) [summary]
19. https://pmc.ncbi.nlm.nih.gov/articles/PMC4714455/ (Kheirkhah et al. 2016: VA outpatient no-show rate 18.8%)
20. https://digital.nhs.uk/data-and-information/publications/statistical/appointments-in-general-practice/november-2025 (NHS GP appointments and DNA; page blocked, the 4.3% figure is from a search summary) [summary]
21. https://www.mgma.com/mgma-stat/strategic-improvements-in-your-rcm-to-reduce-your-practices-claim-denials (MGMA, March 2024: 8% first-pass denial rate and top reasons)
22. https://x12.org/codes/claim-adjustment-reason-codes (X12 CARC definitions)
23. https://www.cms.gov/Medicare/Medicare-Fee-for-Service-Payment/ProspMedicareFeeSvcPmtGen/Downloads/Health_Reform_Timely_Filing_Provider_Notice.pdf (Medicare 12-month filing limit)
24. https://www.philhealth.gov.ph/news/2023/reminds_hospitals.pdf (PhilHealth 60-day filing rule, 2023)
25. https://www.philhealth.gov.ph/advisories/2019/adv2019-0022.pdf (PhilHealth Advisory 2019-0022: RTH claims, SOA/CSF/CF4 attachments)
26. https://www.philhealth.gov.ph/circulars/2020/AnnexD_PhilHealthKonsultaBenefitTable.pdf (Konsulta lab and medicine benefit table) [summary]
27. https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/minimum-necessary-requirement/index.html (HIPAA minimum necessary, role-based access, treatment exception) [summary]
28. https://gdpr-info.eu/art-9-gdpr/ (GDPR Article 9: health data, 9(2)(h) and 9(3))
29. https://privacy.gov.ph/data-privacy-act/ (RA 10173 §3(l): health data is sensitive personal information) [summary]
30. https://www.cdc.gov/vaccines/hcp/downloads/storage-handling-toolkit.pdf (CDC: 2–8 °C; check twice each workday without a digital logger) [summary]
31. https://www.who.int/publications/i/item/WHO-IER-PSP-2010.2 and https://iris.who.int/server/api/core/bitstreams/fc68f57e-3cf6-4fbf-a95d-2686593ea392/content (WHO ICPS framework and technical report; incident type list is from a search summary because the report was blocked) [summary]
32. https://pmc.ncbi.nlm.nih.gov/articles/PMC9792348/ (specimen rejection meta-analysis: pooled 1.99%, main causes) [summary]
33. https://www.ncqa.org/programs/health-plans/credentialing/ (NCQA credentialing; recredentialing every 36 months) [summary]
34. https://www.cdc.gov/flu/about/season.html (CDC: US flu activity peaks December–February)
35. https://www.cms.gov/medicare/payment/fee-schedules/physician/evaluation-management-visits (CMS office visit codes 99202–99205, 99211–99215)
36. https://icd.who.int/browse10/2019/en (WHO ICD-10 browser; the codes above were not checked one by one)
