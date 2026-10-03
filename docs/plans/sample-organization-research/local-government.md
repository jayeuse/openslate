# Research brief: data for a simulated small-city government in OpenSlate


**Question:** How does a small city or municipal office that runs on records actually work?

**Decision it informs:** The design of the OpenSlate sample data for this org type: departments, modules, relationships, automations, volumes, content and refusals.

**Evidence base:** Philippine primary texts were opened and read. They cover RA 11032, the RA 12009 IRR, the Local Government Code, the DBM budget manual, the Family Code, and three city or municipal citizen's charters. Where I only saw a search summary and not the source itself, the claim is marked "(as reported)". Figures marked "(judgment)" are my own estimates.

---

## 1. Reference organization profile

| Attribute | Value | Basis |
|---|---|---|
| Population | 100,000 (range 50k–150k) | brief |
| Staff in the offices covered here | about 250 (the city as a whole is larger once police, fire and health are included) | judgment |
| Council | Mayor, vice-mayor and about 10–12 councilors. Regular sessions at least weekly [12 §52] | LGC |
| Registered businesses | 3,000–5,000, about one per 20–30 residents | judgment |
| Building permits per year | 600–1,500, counting ancillary permits | judgment |
| Service requests per month | 500–1,500 (0.06–0.18 per resident per year) | judgment |
| Annual budget | Philippines: about ₱1–2.5 billion. US: about $150–400M all funds | judgment |
| Fiscal year | Philippines: calendar year [12 §§165, 320]. UK: April to March. US: commonly starts July 1 | UK and US are judgment |

**How it runs.** An elected chief executive leads the city. In the Philippines and in US mayor-council cities this is the mayor. In council-manager cities the council appoints a professional manager instead; ICMA reports about 3,625 US cities use that form [19] (as reported). The council makes law through ordinances and resolutions. Money moves only under an appropriation [12 §305(a)].

Frontline offices do the same few things over and over: take applications, assess fees, collect, and release permits. They work under statutory time limits, such as 3, 7 or 20 working days in the Philippines [3 §9]. Finance is split on purpose so that no single person can both create and complete a payment. The budget officer certifies that an appropriation exists, the accountant obligates it, the treasurer certifies that funds are available, and the head of the office certifies that the claim is valid [12 §344].

The year has a fixed rhythm:
- Business permit renewals and taxes are due in the first 20 days of January [12 §167].
- Property tax is due each quarter [12 §250].
- Budget preparation runs from June to October [13].
- Rain drives drainage complaints from June to November [24].

## 2. Departments in the dataset (8)

| # | Department | Purpose | Head | Staff titles |
|---|---|---|---|---|
| 1 | Business Permits & Licensing (BPLO) | Business registration and renewal, joint inspection, enforcement [8] | BPLO Chief / Licensing Officer IV | Licensing Officer I–III, Permit Evaluator, Encoder (Admin Aide), JIT Inspector |
| 2 | Office of the Building Official (OBO) | Building, ancillary and occupancy permits and inspections [7] | Building Official (licensed engineer or architect) | Plan Evaluator (architectural, structural, electrical, sanitary, mechanical), Building Inspector, Assessment Officer, Receiving/Releasing Officer |
| 3 | Engineering & Public Works (citizen service desk) | Service requests (the 311 function) and field work orders | City Engineer | Action Center Officer, Engineer II, Foreman, Electrician, Maintenance Crew Leader |
| 4 | Treasury | Assessment, collection, deposit, payment release | City Treasurer | Asst. Treasurer, Revenue Collection Officer, Cashier/Collector, Disbursing Officer, Licensing/Assessment Clerk |
| 5 | Budget & Accounting | Appropriations, obligation requests, disbursement vouchers | City Budget Officer and City Accountant (two separate heads, two groups) | Budget Officer II, Accountant II/III, Bookkeeper, Admin Officer |
| 6 | Procurement & General Services | BAC Secretariat, purchasing, supply, property and fleet | City General Services Officer. BAC Chair designated by the mayor [10 §41] | Procurement Officer, BAC Secretariat Head, Supply Officer, Property Custodian, Motorpool Supervisor, Inspection Officer |
| 7 | Human Resources | Plantilla, appointments, leave | City HRM Officer | HRMO II/III, Admin Aide |
| 8 | City Clerk, Records & Council Secretariat | Document tracking, council measures and sessions, civil registry desk | Secretary to the Sanggunian / City Clerk | Records Officer, Legislative Staff Officer, Registration Officer, Records Clerk |

Four regional notes:
- **Department 8.** A Philippine city keeps the Secretary to the Sanggunian and the Local Civil Registrar as separate offices [12 §454]. A US City Clerk often holds both council records and vital records, so I merged them for OpenSlate.
- **Executive group.** Mayor, Administrator and Vice-Mayor are *users in an Executive group*, not a data department. The mayor is the Head of Procuring Entity [13], and the vice-mayor approves spending for the council's own funds [13].
- **US and UK titles.** Business License Specialist, Plans Examiner, Public Works Director, Finance Director/Controller, Purchasing Agent, Fleet Manager, City Clerk.
- **UK.** 311 work is handled by the council's highways or streetscene team.

## 3. Core processes

**A. Business permit, new or renewal** [8] [3 §11]
1. Applicant files the unified form. BPLO frontline checks and verifies it. Record: Business Permit Application, status Filed then Verified.
2. BPLO or Treasury back room assesses taxes and fees and issues a Tax Order of Payment. Record: Order of Payment.
3. Treasury collector accepts payment and issues an Official Receipt (Accountable Form 51 [28], as reported). Records: Official Receipt, then the day's Collection Deposit Report.
4. BPLO prints and releases the permit, valid for one year [3 §11(e)]. The application moves to Released.
5. Within the year, a joint inspection team (BPLO, zoning, sanitation, fire) inspects [8]. Record: Business Inspection. Businesses that do not comply go on a "negative list".
6. For violations, BPLO issues escalating notices [8]: Notice of Violation (7 working days to comply), then Cease and Desist, then Closure Order, then Lifting Order. Record: Enforcement Notice.

Processing time: 1–2 days for new applications and 1 day for renewals (JMC 2016 [4], as reported). In Biñan's charter each step takes minutes to hours [8].

**B. Building permit** [7]
1. Receiving checks completeness and issues an acknowledgment stub.
2. A building inspector does a site inspection (1 day).
3. Evaluators review line and grade, zoning, and each technical discipline.
4. The Assessment Officer prepares the Order of Payment and the Building Official signs it.
5. Treasury collects. OBO records the OR number and assigns permit numbers.
6. The Bureau of Fire Protection issues a Fire Safety Evaluation Clearance.
7. OBO releases the permit.

Totals: Simple 3 days, Complex 7 days, Highly technical 20 days [7]. This matches the RA 11032 §9 tiers [3]. If the office does not act on a complete application within the limit, it is deemed approved [3 §10].

After release: construction-stage inspections. At completion: the Certificate of Occupancy goes through the same steps [7].

**C. Service request to resolution** [1][2]
1. An agent logs the request with channel, type, location and description. Record: Service Request.
2. The agent triages and acknowledges it, or closes it as Duplicate, Not responsible, or Internal referral [2].
3. The engineer investigates and schedules action. Record: Work Order.
4. The crew is dispatched and fixes the problem. The foreman closes the work order.
5. The agent sets the request to Fixed and records status notes.

Open311 publishes only two states, `open` and `closed` [1]. Keep the fuller FixMyStreet-style states internally and map them to open/closed for any public feed.

**D. Purchase request to payment** [10]
1. The end-user office drafts a Purchase Request with its approved budget for the contract (ABC). The item must be in the annual procurement plan.
2. Budget certifies the Obligation Request.
3. The mayor approves the request.
4. The BAC Secretariat consolidates requests into a Procurement Project and picks the mode [10 §26]:
   - Direct acquisition: ABC up to ₱200k, no canvass [10 §32].
   - Small value procurement: at least 3 quotations; posted 3 days if ABC is over ₱200k; city cap ₱2M for 1st–2nd class cities, ₱1.6M for 3rd, ₱1.2M for 4th, ₱0.8M for 5th [10 §34].
   - Competitive bidding: Invitation to Bid posted 7 calendar days [10 §50.3.1]; pre-bid conference if ABC is ₱3M or more, at least 12 days before the bid deadline [10 §51].
5. Bids are opened. Evaluation takes 7 days [10 §61.2.5], then post-qualification.
6. The BAC resolution recommends award. The mayor (Head of Procuring Entity) approves within 10 days and issues the Notice of Award [10 §66.2–66.3]. The contract is signed within 10 days of the award, and the Purchase Order is issued [10 §66.5]. The whole span from bid opening to award must be 60 calendar days or less [10 §67.1].
7. Delivery. Record: Inspection & Acceptance Report. Property items are also recorded as Assets.
8. The Disbursement Voucher moves through: accountant certifies, treasurer certifies funds, mayor approves, treasurer releases payment [12 §344][13].

Exceptions:
- Failed bidding when no bids arrive, all bidders are ineligible, no bid qualifies, or the winner refuses [10 §64.1]. The office reviews the specs and re-bids. A second failure allows negotiated procurement [10 §64.5].
- The UK equivalent is an open or competitive flexible procedure, or direct award. The contract award notice starts a standstill of at least 8 working days [20].
- US rules differ by state. Informal quotes are used below a statutory threshold and sealed bids above it (judgment).

**E. Obligation to disbursement** [12 §344][9][13]
1. The office head certifies the claim. The Budget Officer certifies that the appropriation exists. Record: Obligation Request.
2. The accountant records the obligation in the registry of appropriations, allotments and obligations (RAAO).
3. Accounting pre-audits the DV and journals it. Tuba's charter allows 3 days for this [9].
4. The treasurer certifies that funds are available.
5. The mayor approves. Regular payrolls, utilities and remittances are exempt from mayor approval [12 §344].
6. The treasurer releases a check or direct credit (ADA). Record: Payment Release.

**F. Incoming document to action** (a generic pattern; no single statute)
1. Records receives the document and assigns a tracking number.
2. Records routes it with an instruction, such as "For appropriate action".
3. The action officer acts or replies.
4. Records files and archives it.

Requests under the Philippine FOI order must be answered within 15 working days, extendable up to 20 [17]. EO 2 covers the executive branch only; LGUs are encouraged but not bound [17]. UK FOI requests must be answered within 20 working days [21].

**G. Ordinance** [18][12 §54]
1. A councilor files the measure.
2. First reading, then referral to committee without debate.
3. Committee hearing and committee report.
4. Second reading, with debate and amendment.
5. Third reading, a vote only, with copies given out 3 days before unless the mayor certifies the measure as urgent.
6. The measure goes to the mayor. A veto must come within 10 days (city), or the measure is deemed approved [12 §54].

Resolutions need no third reading unless they are ordinance-like [18].

## 4. Modules (30)

Type key: T = Text, LT = Long text, N = Number, I = Integer, D = Date, DT = Date/Time, CB = Checkbox, S = Select, E = Email, U = URL, Usr = User. An asterisk (*) means required. Select options are listed in lifecycle order; exception states come after the "|".

**BPLO**
1. **Business Establishment.** Business name T\*, Trade name T, Taxpayer/owner T\*, Org type S\* (Sole proprietorship, Partnership, Corporation, One-person corporation, Cooperative), Line of business S\*, District S\*, Address T\*, Registration no. T, Employees I, Email E, Standing S\* (Active, Delinquent, Under notice, Closed by order, Retired).
2. **Business Permit Application.** Application no. T\*, Type S\* (New, Renewal, Amendment, Retirement, Special permit), Tax year I\*, Declared gross sales/capital N\*, Filed at DT\*, Status S\* (Filed, Verified, Assessed, Paid, Approved, Released \| Returned for compliance, Disapproved, Withdrawn), Days pending I, SLA flag S (On time, At risk, Breached), Evaluator Usr, Permit no. T, Valid until D, Remarks LT.
3. **Business Inspection.** Date D\*, Type S\* (Post-issuance joint inspection, Complaint-based, Re-inspection, Closure verification), Agencies present T, Result S\* (Scheduled, Complied, With findings, Failed \| Not found/closed, Cancelled), Findings LT, Comply by D, Lead inspector Usr\*.
4. **Enforcement Notice.** Notice no. T\*, Type S\* (Notice of violation, Notice of delinquency, Cease and desist, Closure order, Lifting order), Violation S\* (No permit, Expired permit, Unpaid tax, No sanitary permit, Fire safety deficiency, Zoning nonconformity, Unpermitted signage), Issued D\*, Compliance days I, Status S\* (Draft, Served, Complied, Escalated, Lifted \| Cancelled), Served by Usr, Remarks LT.

**OBO**

5. **Building Permit Application.** Application no. T\*, Project title T\*, Scope S\* (New construction, Addition, Alteration, Renovation, Repair, Demolition, Legalization, Fencing, Signage), Complexity S\* (Simple, Complex, Highly technical), Estimated cost N\*, Filed at DT\*, Status S\* (Received, Site inspected, Under evaluation, For payment, Paid, Permit issued, Under construction, Completed \| Returned for compliance, Disapproved, Deemed approved, Expired), Days pending I, SLA flag S, Evaluator Usr, Permit no. T, Evaluation findings LT.
6. **Building Inspection.** Type S\* (Pre-permit site, Excavation/foundation, Structural framing, Electrical rough-in, Plumbing rough-in, Final, Illegal-construction complaint), Scheduled D\*, Result S\* (Scheduled, Passed, Passed with notes \| Failed—correction required, Re-inspection scheduled, Stop-work issued, Cancelled), Findings LT, Inspector Usr\*, Photo link U, Re-inspection needed CB.
7. **Occupancy Certificate.** Application no. T\*, Filed D\*, Final inspection passed CB, Status S\* (Received, Under evaluation, For payment, Issued \| Returned for compliance, Disapproved), Days pending I, Certificate no. T, Approved by Usr, Deviations noted LT.

**Public Works**

8. **Service Request** (maps to Open311 [1]). SR no. T\*, Service type S\* (see §9), Channel S\* (Hotline, Walk-in, Online form, Social media, Barangay/ward referral, Staff-observed), Address T\*, District S\*, Description LT\*, Requested at DT\*, Priority S (Low, Normal, High, Emergency), Status S\* (New, Acknowledged, Investigating, Action scheduled, In progress, Fixed \| No further action, Not responsible, Duplicate, Internal referral, Reopened), Status notes LT, Expected by D, Assigned to Usr. Latitude and longitude can be added as N fields if needed.
9. **Work Order.** WO no. T\*, Work type S\* (Pothole patching, Declogging/desilting, Streetlight repair, Tree trimming, Sidewalk repair, Manhole cover replacement, Special garbage pickup, Sign repair), Crew S (Crew 1–4, Electrical team, Motorpool), Scheduled D\*, Status S\* (Planned, Dispatched, On site, Completed, Verified \| On hold—materials, Cancelled), Materials used LT, Labor hours N, Completed at DT, Foreman Usr\*.

**Treasury**

10. **Order of Payment.** OOP no. T\*, Source S\* (Business permit, Building permit, Occupancy, Civil registry, Real property tax, Other), Payor T\*, Amount due N\*, Surcharge/interest N, Due D, Status S\* (Unpaid, Partially paid, Paid \| Reassessed, Cancelled), Assessed by Usr\*, Fee breakdown LT.
11. **Official Receipt.** OR no. T\*, Issued at DT\*, Payor T\*, Amount N\*, Mode S\* (Cash, Check, Online/e-wallet, Bank deposit), Nature S\* (Business tax, Regulatory fee, Building/ancillary fees, RPT basic, RPT SEF, Civil registry fee, Surcharge/interest, Other), Collector Usr\*, Status S\* (Issued \| Cancelled/spoiled), Remarks LT. Cancelled receipts stay in the series; they are never deleted.
12. **Collection Deposit Report** (daily). Report date D\*, Collector Usr\*, OR from T\*, OR to T\*, Total collected N\*, Deposited N, Deposit date D, Status S\* (Draft, Submitted, Deposited, Reconciled \| Discrepancy).
13. **Payment Release.** Check/ADA no. T\*, Payee T\*, Net amount N\*, Mode S\* (Check, ADA/direct credit, Disbursing officer cash), Prepared D\*, Funds certified CB\*, Status S\* (Prepared, Signed, Released, Cleared \| Stale, Cancelled), Released by Usr\*.

**Budget & Accounting**

14. **Appropriation.** Fiscal year I\*, Office S\*, Expense class S\* (Personal services, MOOE, Capital outlay, Financial expenses), Account code T\*, Description T\*, Appropriated N\*, Allotted N, Obligated to date N, Balance N (entered by hand, since there is no formula type), Source S (Annual, Supplemental No. 1, Supplemental No. 2, Continuing), Status S (Proposed, Enacted, Reenacted, Closed).
15. **Obligation Request.** ObR no. T\*, Requesting office S\*, Payee T\*, Particulars LT\*, Amount N\*, Filed D\*, Status S\* (Filed, Certified—appropriation exists, Obligated \| Returned—insufficient allotment, Returned—wrong account code, Cancelled), Budget officer Usr.
16. **Disbursement Voucher.** DV no. T\*, Payee T\*, Particulars LT\*, Gross N\*, Tax withheld N, Net N\*, Fund S\* (General Fund, Special Education Fund, Trust Fund, 20% Development Fund), Claim certified by Usr\*, Received D\*, Status S\* (Received, Pre-audited, Certified by Accountant, Funds certified, Approved for payment, Paid \| Returned—incomplete documents, Disallowed in pre-audit, Cancelled), Journal entry no. T, Days pending I.

**Procurement & GSO**

17. **Supplier.** Name T\*, TIN T\*, Registry no. T, Type S\* (Goods, Infrastructure contractor, Consulting, Service provider), Contact person T, Email E, Address T, Status S\* (Active, Inactive \| Suspended, Blacklisted).
18. **Purchase Request.** PR no. T\*, Office S\*, Purpose LT\*, Item summary LT\*, ABC N\*, In procurement plan CB\*, Date D\*, Requested by Usr\*, Recommended mode S, Status S\* (Draft, Submitted, Budget-cleared, Approved, Endorsed to BAC, Consolidated \| Returned, Cancelled).
19. **Procurement Project.** Reference no. T\*, Title T\*, Mode S\* (Competitive bidding, Limited source bidding, Direct contracting, Direct acquisition, Repeat order, Small value procurement, Negotiated—two failed biddings, Negotiated—emergency, Direct sales), ABC N\*, Posted D, Bid opening DT, Days since opening I, Timeline flag S (On track, At risk, Over 60-day cap), Status S\* (Pre-procurement conference, Posted, Pre-bid held, Bids opened, Under evaluation, Post-qualification, Recommended for award, Awarded, Contract signed, Notice to proceed \| Failed bidding, Re-bid posted, Second failure—negotiated, Cancelled), BAC resolution no. T, Procurement officer Usr.
20. **Bid / Quotation.** Bidder T\*, Amount N\*, Submitted DT\*, Eligibility S\* (Eligible, Ineligible), Evaluation S\* (Pending, Responsive, Lowest calculated, Lowest calculated responsive bid \| Non-responsive, Post-disqualified), Rank I, Remarks LT.
21. **Purchase Order / Contract.** PO no. T\*, Amount N\*, PO date D\*, Delivery days I, Delivery due D, Place of delivery T, Status S\* (Issued, Conformed, Partially delivered, Delivered, Accepted, Paid \| Terminated, Liquidated damages applied), Approved by Usr\*.
22. **Inspection & Acceptance Report.** IAR no. T\*, Delivered D\*, Invoice no. T, Result S\* (Complete & conforming, Partial \| Rejected—nonconforming, Rejected—short delivery), Accepted D, Inspection officer Usr\*, Property custodian Usr, Remarks LT.
23. **Property & Fleet Asset.** Property no. T\*, Description T\*, Category S\* (Motor vehicle, Heavy equipment, ICT, Furniture, Streetlight fixture, Tools, Other), Acquired D, Cost N\*, Accountable officer Usr, Office S, Plate no. T, Odometer N, Condition S\* (Serviceable, Needs repair, Unserviceable, For disposal, Disposed \| Lost).

**Human Resources**

24. **Plantilla Position.** Item no. T\*, Title T\*, Salary grade I\*, Office S\*, Monthly salary N, Incumbent T, Last published D, Status S\* (Filled—permanent, Filled—temporary, Vacant—funded, Vacant—unfunded, Abolished).
25. **Personnel Action.** Type S\* (Original appointment, Promotion, Transfer, Reemployment, Resignation, Retirement), Employee T\*, Nature S (Permanent, Temporary, Coterminous, Casual), Effective D\*, Status S\* (Vacancy published, Screening, Deliberated, Appointment signed, Submitted to CSC, Attested \| Disapproved, Invalidated), HR officer Usr\*, Remarks LT.
26. **Leave Application** (CS Form 6 [16]). Employee T\*, Type S\* (Vacation, Sick, Mandatory/forced, Special privilege, Maternity, Paternity, Solo parent, Study, Other), Start D\*, End D\*, Working days N\*, With pay CB, Status S\* (Filed, Recommended, Credits certified, Approved \| Disapproved, Cancelled), Approver Usr, Reason LT.

**Clerk, Records & Council**

27. **Communication.** Tracking no. T\*, Direction S\* (Incoming, Outgoing, Internal), Document type S\*, Sender/addressee T\*, Subject T\*, Dated DT\*, Action required S (For information, For appropriate action, For comment, For signature, For compliance, FOI request), Routed to S, Priority S (Routine, Urgent), Due D, Status S\* (Received, Routed, In action, Acted, Filed \| Returned, Duplicate), Action officer Usr.
28. **Legislative Measure.** Measure no. T\*, Kind S\* (Ordinance, Resolution, Appropriation ordinance, Revenue ordinance), Title T\*, Authors T\*, Committee S\*, Filed D\*, Status S\* (Filed, First reading—referred, In committee, Committee report, Second reading, Approved on third reading, Transmitted to Mayor, Signed \| Vetoed, Deemed approved, Laid on the table, Withdrawn), Approved D, Effectivity D.
29. **Council Session.** Session no. T\*, Type S\* (Regular, Special), Date DT\*, Presiding officer T, Quorum CB, Status S\* (Scheduled, Held, Minutes approved \| No quorum, Cancelled), Items taken up LT.
30. **Civil Registry Entry.** Registry no. T\*, Event S\* (Birth, Death, Marriage, Marriage license application), Event date D\*, Registered D\*, Timeliness S (Timely, Delayed), Status S\* (Received, Reviewed, Registered, Transmitted to national registry \| Posted 10 days, For correction, Rejected), Registration officer Usr\*, Remarks LT. Store no personal names; see §11.

## 5. Relationships

| # | From → To | Cardinality | Reason |
|---|---|---|---|
| 1 | Business Establishment → Permit Application | 1–N | Yearly renewals, amendments, retirement |
| 2 | Business Establishment → Business Inspection | 1–N | Annual joint inspection plus complaints |
| 3 | Business Establishment → Enforcement Notice | 1–N | Escalating notices |
| 4 | Business Inspection → Enforcement Notice | 1–N | A notice cites its findings |
| 5 | Permit Application → Order of Payment | 1–N | Quarterly installments, reassessment [12 §165] |
| 6 | Building Permit → Building Inspection | 1–N | Stage inspections |
| 7 | Building Permit → Occupancy Certificate | 1–1 | One certificate per permitted project |
| 8 | Building Permit → Order of Payment | 1–N | Building fee plus ancillary fees |
| 9 | Order of Payment → Official Receipt | 1–N | Installments |
| 10 | Collection Deposit Report → Official Receipt | 1–N | The daily report covers an OR series |
| 11 | Service Request ↔ Work Order | N–N | One crew job clears several nearby requests |
| 12 | Work Order ↔ Property & Fleet Asset | N–N | Vehicles and equipment used |
| 13 | Appropriation → Obligation Request | 1–N | Charged to a line item |
| 14 | Obligation Request → Disbursement Voucher | 1–N | Partial or progress payments |
| 15 | Disbursement Voucher → Payment Release | 1–1 | One check or ADA per DV |
| 16 | Procurement Project → Purchase Request | 1–N | Requests consolidated into a project |
| 17 | Procurement Project → Bid/Quotation | 1–N | Bidders |
| 18 | Supplier → Bid/Quotation | 1–N | Bid history |
| 19 | Procurement Project → Purchase Order | 1–N | One PO per lot |
| 20 | Supplier → Purchase Order | 1–N | Award history |
| 21 | Purchase Order → Obligation Request | 1–1 | The obligation for the contract |
| 22 | Purchase Order → IAR | 1–N | Partial deliveries |
| 23 | Disbursement Voucher → IAR | 1–N | The IAR supports the claim |
| 24 | IAR → Property & Fleet Asset | 1–N | Equipment put on the register |
| 25 | Plantilla Position → Personnel Action | 1–N | Appointment history |
| 26 | Plantilla Position → Leave Application | 1–N | Leave by the incumbent |
| 27 | Council Session ↔ Legislative Measure | N–N | A measure is read across several sessions |
| 28 | Communication ↔ Legislative Measure | N–N | Endorsements and transmittals |

## 6. Automations (12)

The rule engine has no date arithmetic. It cannot check "filed more than 3 working days ago." SLA rules therefore need a number field, **Days pending**, that the simulation increments each working day. A threshold-crossed rule then reads that field.

| # | Module | Event | Condition | Action |
|---|---|---|---|---|
| 1 | Business Permit App. | Status changed | Status = Assessed | Create Order of Payment (Source = Business permit, Status = Unpaid) |
| 2 | Business Permit App. | Days pending crosses 1 | Type = Renewal | SLA flag = At risk (1-day renewal standard [4], as reported) |
| 3 | Business Permit App. | Days pending crosses 3 | none | SLA flag = Breached (RA 11032 simple tier [3 §9]) |
| 4 | Building Permit | Days pending crosses 7 | Complexity = Complex | SLA flag = Breached; deemed-approval risk [3 §10] |
| 5 | Business Inspection | Result changed | Result = Failed | Create Enforcement Notice (Notice of violation, Draft, Compliance days = 7 [8]) |
| 6 | Service Request | Record created | Type = Clogged drainage/flooding | Priority = High |
| 7 | Service Request | Status changed | Status = Action scheduled | Create Work Order (Status = Planned) |
| 8 | Purchase Request | ABC crosses 2,000,000 | none | Recommended mode = Competitive bidding (above the SVP cap for a 1st–2nd class city [10 §34.2]) |
| 9 | Procurement Project | Days since opening crosses 60 | none | Timeline flag = Over 60-day cap [10 §67.1] |
| 10 | Disbursement Voucher | Days pending crosses 3 | none | Set a flag (the 3-day charter step [9]; add an SLA flag field) |
| 11 | Legislative Measure | Status changed | Status = Approved on third reading | Create Communication (Outgoing, Transmittal, For signature, Routed to = Mayor) |
| 12 | Council Session | Weekly, Wednesday 08:00 | none | Create Session (Regular, Scheduled) [12 §52][18] |

A daily 16:30 Collection Deposit Report draft would also help. The rule would fire on weekends, so use five weekly rules, one for each day Monday to Friday.

## 7. Volumes: 12 months, January to December (6,187 records)

| Module | n | Module | n | Module | n |
|---|---|---|---|---|---|
| Business Establishment | 300 | Order of Payment | 520 | Bid/Quotation | 190 |
| Business Permit App. | 360 | Official Receipt | 500 | Purchase Order | 72 |
| Business Inspection | 110 | Collection Deposit Rpt | 240 | IAR | 75 |
| Enforcement Notice | 30 | Payment Release | 250 | Property & Fleet Asset | 130 |
| Building Permit App. | 110 | Appropriation | 110 | Plantilla Position | 200 |
| Building Inspection | 220 | Obligation Request | 280 | Personnel Action | 30 |
| Occupancy Certificate | 40 | Disbursement Voucher | 265 | Leave Application | 270 |
| Service Request | 700 | Supplier | 55 | Communication | 350 |
| Work Order | 300 | Purchase Request | 110 | Legislative Measure | 70 |
| | | Procurement Project | 80 | Council Session | 50 |
| | | | | Civil Registry Entry | 170 |

**How the ratios hold together** (the dataset is a sample; real volumes are about 5–15 times higher):
- **Business permits.** 360 applications = 250 renewals + 50 new + 25 amendments + 15 retirements + 20 special permits.
- **Treasury.** Orders of Payment = 360 business + 110 building + 40 occupancy + 10 other. Official Receipts ≈ 94% of those orders plus installments.
- **Service requests.** About 43% get a work order. The rest close as duplicate, referral or no further action.
- **Obligations.** 280 = 72 purchase orders + 96 payroll/allowance runs (8 offices × 12 months) + 48 utilities + 64 travel/other.
- **Procurement.** 110 purchase requests roll into 80 projects, which draw about 2.4 bids each and produce 72 POs.
- **Building permits.** About 2 inspections per permit.

**Peaks:**
- About 80% of renewals (≈200) fall between January 2 and 20 [12 §167].
- Quarterly tax installments rise in the first 20 days of April, July and October [12 §167].
- Property tax payments rise before March 31, June 30, September 30 and December 31 [12 §250].
- Service requests run about 1.6 times higher in June–November because of drainage and flooding [24] (judgment on the multiplier).

## 8. Status snapshot on September 30, and the share that still moves by December 31

| Module | Distribution on Sept 30 | Moves later |
|---|---|---|
| Business Permit App. | Released 88%, in progress 4%, Returned for compliance 4%, Disapproved 2%, Withdrawn 2% | 5% |
| Building Permit | Issued, under construction or completed 72%, in evaluation or for payment 12%, Returned 10%, Disapproved 3%, Expired 3% | 35% (construction to completed, resubmissions) |
| Service Request | Fixed 62%, Duplicate 8%, Not responsible 7%, No further action 3%, Internal referral 2%, open states 16%, Reopened 2% | 18% |
| Work Order | Completed or verified 85%, planned or dispatched 9%, On hold—materials 4%, Cancelled 2% | 13% |
| Disbursement Voucher | Paid 80%, in process 12%, Returned—incomplete 6%, Disallowed 1%, Cancelled 1% | 15% |
| Procurement Project | Contract or NTP 60%, in process 25%, Failed or re-bid 8%, Negotiated after second failure 2%, Cancelled 5% | 35% |
| Legislative Measure | Signed 55%, in committee 30%, first reading 5%, Laid on the table 5%, Withdrawn 3%, Vetoed 2% | 30% |
| Leave Application | Approved 90%, pending 4%, Disapproved 3%, Cancelled 3% | 4% |
| Communication | Filed 70%, Acted 15%, Routed or in action 12%, Returned or duplicate 3% | 12% |

All figures in this table are judgment. They are consistent with the processing limits cited above.

## 9. Content vocabulary (invented names only)

**Number formats** (judgment, modeled on charter practice):
- BP-2026-00412, OBO-BP-2026-0318, CO-2026-0041
- SR-26-011482, WO-26-0873
- OOP-2026-05731; OR 8834127 (7-digit AF 51 series [28], as reported)
- ObR 100-2026-03-0233
- DV 2026-03-0417 (serial–month–year, one series per year [29], as reported)
- PR-2026-0142, PO-2026-0098, IAR-2026-0077, BAC Res. 2026-031
- Ord. No. 2026-017, Res. No. 2026-142
- IN-2026-04-0931, OUT-2026-04-0212
- Item No. OSEC-ENG-12

**Lines of business:** convenience store, carinderia/eatery, bakery, hardware and construction supply, pharmacy, water refilling station, laundry shop, barbershop/salon, auto repair shop, rice retailer, printing and internet shop, boarding house, medical clinic, private school, pawnshop/lending, gasoline station, warehouse, general contractor, space lessor, professional services.

**Fee items:** mayor's permit fee; business tax (on gross sales); garbage fee; sanitary inspection fee; fire code fee (collected for the fire bureau); signboard fee; zoning/locational clearance fee; building permit fee; electrical, mechanical and plumbing fees; line and grade fee; occupancy fee; certified true copy fee; marriage license fee; RPT basic; RPT SEF; surcharge 25% and interest 2% a month [12 §168].

**Service request types:** pothole; streetlight out; streetlight flickering; clogged drainage or canal; street flooding; open or missing manhole cover; uncollected garbage; illegal dumping; fallen tree or branch; damaged sidewalk; damaged road sign; road obstruction; illegal construction report; stray animals; leaking water main (utility, so "Not responsible"); graffiti.

**Inspection findings:**
- "Fire extinguisher expired, recharge within 7 days"
- "Operating without sanitary permit"
- "Signage installed without permit"
- "Rear setback 1.2 m vs 2.0 m required"
- "Added mezzanine not in approved plans"
- "Rebar spacing conforms"
- "Exposed wiring at service entrance"
- "Occupying building without CO"
- "Fire exit obstructed by stock"
- "Grease trap not installed"
- "Complied, no findings"

**Procurement items:**
- Supply and delivery of office supplies, Q2
- A4 70gsm bond paper (ream)
- Toner cartridges
- 100W LED streetlight luminaires, 60 units
- Cold-mix asphalt, 400 bags
- 910mm RC culvert pipes
- Gravel and sand
- Portland cement, 40kg bags
- Janitorial supplies
- Fuel, diesel and gasoline
- Repair of dump truck
- Double-cab pickup, 1 unit
- Desktop computers, 12 units
- Catering for budget hearings
- CCTV installation, city hall
- Desilting of Acacia Creek drainage canal
- Asphalt overlay, Molave Street

**Modes:** see §3D.

**Document types:** letter-request; memorandum; endorsement; executive order; office order; travel order; invitation; complaint; subpoena; COA audit observation memorandum; DILG memorandum circular; barangay/ward resolution; transmittal; certification; FOI request; position paper.

**Note phrasing staff actually write:**
- "Returned: no lease contract. Advised to comply within 5 working days."
- "Assessed; ToP issued; advised to pay at window 3."
- "For L&G evaluation."
- "Pre-audited, lacking IAR, returned to GSO."
- "Duplicate of SR-26-011402."
- "Not LGU jurisdiction, referred to water district."
- "Crew 2 scheduled Thu AM, 6 bags cold mix."
- "Failed bidding: no bids received. For review of specs."
- "Laid on the table pending public hearing."
- "Forwarded to CTO for fund certification."

## 10. Board content, Q1 (January–March)

- **BPLO.** Renewal deadline January 20 [12 §167]; extended weekend hours; online renewal link; list of documents; JIT inspection schedule by district (February–March); "Negative list" advisory.
- **Treasury.** Property tax 1st-quarter deadline March 31 and the advance-payment discount (up to 20% [12 §251]); collection hours; e-payment channels.
- **OBO.** Updated schedule of fees; seminar for contractors; closure notice for system maintenance.
- **Public Works.** Pothole blitz week; drainage desilting before the rains (March); hotline number.
- **Budget & Accounting.** First-quarter release of allotments; cutoff for DV submission; reminder on complete supporting documents.
- **Procurement.** Approved procurement plan published; pre-bid conference dates; BAC meetings every Tuesday; supplier registration drive.
- **HR.** Publication of vacancies; performance ratings due; leave credit balances released; Civil Service exam date.
- **Clerk and Council.** Weekly session calendar; public hearing on the revenue code amendment; mass wedding event (February); FOI desk hours.

## 11. Access patterns and planned refusals

Public finance separates four roles: authorization, recording, custody, and reconciliation or audit [23][22]. The Philippine law splits them by signature [12 §344]. The mayor (Head of Procuring Entity) is never a BAC member. The accountant and treasurer are not regular BAC members [10 §41.2.5].

**Groups:**

| Group | Write | Read |
|---|---|---|
| BPLO | BPLO modules | Order of Payment |
| OBO | OBO modules | Order of Payment |
| Public Works | Service Request, Work Order | Assets |
| Treasury—Assessment | Order of Payment | |
| Treasury—Collection | Official Receipt, Deposit Report | |
| Treasury—Disbursing | Payment Release | |
| Budget | Appropriation, Obligation Request | |
| Accounting | DV | everything in finance |
| Executive | DV status (approval), Procurement Project award, Purchase Order | |
| BAC/Secretariat | Project, Bid, Supplier | Purchase Request |
| GSO | Purchase Order, IAR, Assets | |
| HR | HR modules | |
| Clerk | Communication, Legislative Measure, Session | |
| Civil Registry | Civil Registry Entry only | |
| COA/State auditor | none (guest, capped at read) | all finance and procurement modules |

**Planned refusals:**
1. A BPLO licensing officer tries to create or approve a Disbursement Voucher for their office. They have no write on Accounting [12 §344].
2. A Treasury collector tries to lower an Order of Payment amount after taking cash. This mixes custody and assessment [22]. They have no write on Order of Payment.
3. The accountant tries to mark a Payment Release as Released. That is treasurer custody; accounting can only read it.
4. The City Treasurer tries to enter a bid evaluation. The treasurer is not a regular BAC member [10 §41.2.5].
5. A Public Works engineer tries to create the IAR for their own delivered culvert pipes. Only GSO inspection can create IARs. This is judgment based on standard practice.
6. The COA/state auditor (guest) tries to set a DV to Disallowed. Guests can only read. The auditor's observation is logged as a Communication instead.
7. A council secretariat clerk opens a Civil Registry Entry. They have no access, so the record is hidden (404). This protects personal data under RA 10173 (cited in [17]).
8. An OBO evaluator tries to edit a Plantilla Position salary grade. They have no write on HR.

**Gap for the parent.** OpenSlate access is set per module. It cannot stop "approver = preparer" inside one module. Conditions compare fields to literals, not to other fields. So:
- Build refusals only across module or department boundaries.
- Put each certifying signature in the module owned by the certifying office, as the design above does.
- Detect any self-approval inside a module through audit review, not permissions.

## 12. Cadences and seasonality

| When | Event |
|---|---|
| Jan 1–20 | Business tax, permit renewal peak; late payers get 25% surcharge and 2%/month interest [12 §§167–168] |
| First 20 days of Apr, Jul, Oct | Quarterly business tax installments [12 §167] |
| Mar 31, Jun 30, Sep 30, Dec 31 | Property tax installment deadlines [12 §250] |
| June (DBM example: June 16) | Budget call [13] |
| Jul 15 | Treasurer's income statement and department budget proposals due [13] |
| Aug–Sep | Technical budget hearings [13] |
| Oct 16 | Executive budget submitted to council [12 §318] |
| Nov–Dec | Council deliberation. Appropriation ordinance by Dec 31, effective Jan 1; otherwise the old budget is reenacted [12 §§319–320][13] |
| Jun–Nov | Rainy and typhoon season; drainage, flooding, fallen-tree peaks [24] |
| Nov–Dec | Forced leave taken before it is forfeited [16]; year-end rush to obligate and pay (judgment) |
| Weekly | Council regular session [12 §52] |
| Daily | Collection deposit report (judgment on the cadence) |

UK and US variants:
- UK: fiscal year April–March; potholes peak after winter freeze-thaw (judgment).
- US: fiscal year often starts July 1, so the budget is adopted May–June; potholes peak February–April (judgment).

Civil registry: births are registered within 30 days [15] (as reported). Marriage licenses need 10 consecutive days of public posting and are valid 120 days. Officiants send the certificate within 15 days [14]. Keep death registration generic; my sources gave conflicting periods.

## 13. Sources

1. https://wiki.open311.org/GeoReport_v2/ (request fields; statuses open/closed only)
2. https://fixmystreet.org/running/admin_manual/ (open, fixed and closed report states)
3. https://lawphil.net/statutes/repacts/ra2018/ra_11032_2018.html (RA 11032 §§6, 7, 9, 10, 11)
4. https://www.dilg.gov.ph/issuances/jc/Revised-Standards-in-Processing-Business-Permits-and-Licenses-in-All-Cities-and-Municipalities-/65 (JMC 01 s.2016; 1–2 days new, 1 day renewal, as reported)
5. https://www.alburolaw.com/guidelines-for-processing-business-permits-related-clearances-and-licenses-in-all-cities-and-municipalities-under-arta-dti-dilg-dict-joint-memorandum-circular-no-01-series-of-2021/ (JMC 2021-01 eBOSS; summary)
6. https://www.dilg.gov.ph/issuances/jc/Guidelines-in-Streamlining-the-Processes-for-the-Issuance-of-Building-Permits-and-Certificates-of-Occupancy/87 (JMC 2018-01; 5 LGU days + 3 fire bureau days, as reported)
7. https://assets.pasigcity.gov.ph/storage/attachments/office_of_the_building_official/662a0f0f75d821714032399ENGLISH.pdf (Pasig OBO charter; steps and 3/7/20-day totals)
8. https://www.binan.gov.ph/wp-content/uploads/2017/12/Office-of-the-City-Business-Permit-and-Licensing-Citizens-Charter.pdf (Biñan BPLO charter; Tax Order of Payment, JIT, notices, retirement)
9. https://www.tuba.gov.ph/wp-content/uploads/2026/01/MACCO-2025.pdf (Tuba accounting charter; DV processing)
10. https://www.gppb.gov.ph/wp-content/uploads/2025/02/Implementing-Rules-and-Regulations-of-RA-12009.pdf (RA 12009 IRR §§26, 32, 34, 41, 50, 51, 61, 64, 66, 67)
11. https://www.gppb.gov.ph/fit-for-purpose-procurement-modalities-under-ra-12009/ (list of procurement modes)
12. https://lawphil.net/statutes/repacts/ra1991/ra_7160_1991.html (LGC §§52, 54, 165–168, 250–251, 305, 318–320, 325, 344, 454)
13. https://www.dbm.gov.ph/wp-content/uploads/Issuances/2023/Local-Budget-Circular/Budget%20Operations%20Manual%20for%20LGUs,%202023%20Edition.pdf (budget calendar and roles)
14. https://lawphil.net/executive/execord/eo1987/eo_209_1987.html (Family Code Arts. 17, 20, 23)
15. https://psa.gov.ph/civilregistration/facts (registration periods; as reported, page blocked)
16. https://legal.uplb.edu.ph/wp-content/uploads/2023/07/1998-CSC-MC-41-Revised-Omnibus-Rules-on-Leave.pdf (leave rules; as reported)
17. https://www.pdic.gov.ph/files/foi/Annex_A-EO_2_FOI.pdf (EO 2 FOI; 15 working days, extension to 20)
18. https://www.bacolorpampanga.gov.ph/File/Resolutions/2025/EXCERPTS%20-%20Resolution%20No.%20103,%20S-2025%20%20-%20Internal%20Rules%20of%20Procedure%202025-2028.pdf (three readings, order of business)
19. https://icma.org/blog-posts/municipal-form-government-numbers (council-manager count; as reported)
20. https://www.gov.wales/procurement-act-2023-guidance-contract-award-notices-and-standstill-html (UK 8-working-day standstill)
21. https://ico.org.uk/for-organisations/foi/freedom-of-information-and-environmental-information-regulations/time-limits-for-compliance-under-the-freedom-of-information-act-section-10/ (UK FOI 20 working days; as reported)
22. https://sao.wa.gov/sites/default/files/2023-04/Segregation-of-Duties-Guide.pdf (custody, recording, reconciliation, authorization)
23. https://www.pefa.org/node/4916 (PEFA PI-25 segregation and commitment controls; as reported)
24. https://www.rappler.com/philippines/weather/pagasa-rainy-season-2026/ (June onset; June–November cyclones; as reported)
25. https://www.slc.gov/buildingservices/permitting-process/ (US permit flow: intake, review, corrections, inspections, CO)
26. https://developer.accela.com/docs/construct-subObjects.html (inspection statuses such as Approved, Pending, Denied)
27. https://www.gfoa.org/budget-process-101 (GFOA budget process; not opened)
28. https://www.dbm.gov.ph/wp-content/uploads/Bids/Agency-to-Agency/2020/2020-002.pdf (AF 51 official receipt; as reported)
29. https://blgf.gov.ph/wp-content/uploads/2016/01/Instructions-Disbursement-Voucher.pdf (DV serial–month–year; as reported, page blocked)
