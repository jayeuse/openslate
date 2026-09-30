# Commercial HVAC/R sales and field service: reference model for OpenSlate simulation

**Equipment choice: commercial HVAC and refrigeration (HVAC/R).** I chose it for three reasons:
- It has the best published maintenance task lists (ASHRAE/ACCA Standard 180 [16][17]).
- Refrigerant law requires records, which gives realistic compliance modules (US EPA Section 608 and ER&R [18][19][20], EU F-gas [21]).
- The work mixes installation projects, preventive maintenance contracts and seasonal breakdown calls.

A generator or kitchen-equipment company would use the same model with different equipment and checklists.

## 1. Reference organization profile

Every figure in this section is my judgment. I sized it from staff ratios, not from a survey.

| Item | Value |
|---|---|
| Headcount | 105 (field 70, office 35) |
| Service technicians | 38 (8 refrigeration specialists), plus 6 apprentices |
| Installers | 14, in 4 crews |
| Active customer accounts / sites | 650 / 1,400 (retail, grocery, restaurants, offices, schools, clinics, light industry) |
| Installed assets under management | ~8,500 (about 6 per site) |
| Active service contracts / maintenance plans | 550 / 800 |
| Stocked part numbers | ~3,200 in the warehouse; 250–400 on each van |
| Active suppliers | ~120 (about 15 carry 80% of spend) |
| Stock locations | 1 warehouse, 1 quarantine/returns cage, 44 vans and trucks |

**Daily operation.** At 07:00 dispatch reviews the board: emergency (P1) calls taken overnight, carried-over jobs and planned maintenance (PM) visits. Technicians drive from home in stocked vans. They take 2–3 visits a day, record parts and refrigerant use, fill in PM checklists, and flag faults that need a repair quote. Parts staff restock vans weekly, raise special orders for jobs waiting on parts, and receive supplier deliveries. Service coordinators check completed work orders before billing. Finance invoices time-and-materials jobs daily and contracts monthly, applies cash and chases overdue invoices. Sales turns PM findings and end-of-life equipment into replacement quotes, which become installation projects.

**Regional differences.** US sites follow EPA Section 608. For HFC appliances with 15 lb or more of charge, the ER&R leak-repair rules apply from 1 Jan 2026 [19][20]. EU sites set leak-check intervals by tonnes of CO₂e and keep records for 5 years [21]. Capacity is in tons in the US and kW elsewhere; refrigerant is in lb or kg. Southern-hemisphere seasons are reversed. Tropical regions have cooling demand all year.

## 2. Departments

| Department | Purpose | Lead / staff titles |
|---|---|---|
| Sales & Estimating | Accounts, opportunities, quotes, orders, contract sales | Sales Manager / Account Manager (3), Estimator (2), Service Agreement Sales Rep, Sales Coordinator |
| Customer Service & Dispatch | Service requests, triage, scheduling, contracts, PM planning | Service Manager / Dispatch Lead, Dispatcher-CSR (4), Service Coordinator (2), Contracts Administrator |
| Field Service | Doing the work, assets, checklists, refrigerant records | Field Service Manager / Field Supervisor (4), HVAC/R Service Technician (38), Refrigeration Technician, Apprentice (6) |
| Installation Projects | Equipment replacement and new installs | Projects Manager / Project Manager (3), Site Superintendent, Installer/Pipefitter (14) |
| Parts & Purchasing | Item master, stock, vans, purchasing, receiving, warranty | Purchasing Manager / Buyer (2), Warehouse & Parts Counter (3), Warranty Administrator |
| Finance | Billing, cash, collections, credit notes, supplier bills | Controller / Billing Specialist (2), AR & Collections Specialist, AP Clerk, Payroll |

Leadership (General Manager, Operations Director) holds the admin role and posts company-wide Board content.

## 3. Core processes

The five end-to-end chains map to APQC PCF categories: Market and Sell, Deliver Services, Manage Customer Service, Deliver Physical Products (procurement) and Manage Financial Resources [1]. Revenue accounting covers customer credit, invoicing, AR, collections and adjustments [2].

**A. Lead-to-order (includes quote-to-install)**
1. An Account Manager or a technician raises a lead, often a PM finding → **Opportunity**.
2. The Estimator does a site survey and prices the job → **Quote** (revisions share one number with Rev A/B).
3. The customer accepts → **Sales Order**. Finance does the credit check.
4. The Project Manager plans the job → **Installation Project**. Buyers order the equipment → **Purchase Order**.
5. The crew installs, starts up and commissions the unit → **Asset** (new), **Inspection Checklist** (start-up), **Change Orders**.
6. Finance bills progress, then the final amount and the retainage release → **Invoice**. US progress billing uses AIA G702/G703 with 5–10% retainage [28].

**B. Request-to-resolution (reactive)**
1. The CSR takes the call, checks entitlement and sets priority from impact and urgency (ITIL style) → **Service Request** [26].
2. The Dispatcher creates and books the work → **Work Order** and **Service Appointment**. The status model follows Dynamics 365 (Unscheduled → Scheduled → In Progress → Completed → Posted) [3] and Salesforce (appointment: Scheduled → Dispatched → In Progress → Completed / Cannot Complete) [9].
3. The technician travels, diagnoses and repairs → **Parts Used**, **Refrigerant Log Entry**, tech notes.
4. If the tech cannot finish (parts, second tech, access): Appointment = Cannot Complete, the Buyer raises a **PO**, and the dispatcher books a return visit.
5. The Service Coordinator reviews the work order → Finance issues an **Invoice** (T&M) or no charge (contract, warranty, callback).
6. A failed part under manufacturer warranty → **Warranty Claim** (the Warranty Administrator handles it; Salesforce models covered parts, labor and expenses [11]).

**C. Plan-to-maintain (PM)**
1. The Contracts Administrator sets up coverage → **Service Contract** (SLA, hours of cover, billing frequency).
2. The Service Coordinator defines visits → **Maintenance Plan** (frequency, how many months ahead to generate, one work order per site or per asset). This follows Salesforce and D365 agreements [4][10].
3. Plans generate PM **Work Orders** about 1 month ahead. Dispatch books them in slack time.
4. The tech follows the checklist → **Inspection Checklist**. Standard 180 tasks: filters checked quarterly; belts, VFDs, coils and drains semiannually; refrigerant temperatures, contactors and bearings annually (RTU table 5-22, 2012 edition) [17].
5. A deficiency → **Quote** (repair proposal) → chain A.

**D. Procure-to-pay**
1. The Buyer raises the order (weekly stock, job special order or project equipment) → **PO** Draft → Submitted → Approved [7].
2. The supplier ships. The warehouse records receipt; one PO can have several receipts [7] → **Goods Receipt**.
3. Parts go to the warehouse or onto vans (vans are stock locations [6]) → **Stock Transfer**.
4. The AP Clerk matches the supplier's invoice to the PO and the receipt (three-way match) → **Supplier Bill** → Paid.

**E. Order-to-cash**
1. Billing Specialists invoice reviewed work orders daily, contracts on the 1st, and projects by pay application → **Invoice**.
2. The AR Specialist applies cash → **Payment** (one payment can clear several invoices; partial payments happen).
3. Dunning at 30, 60 and 90+ days → **Collection Activity**. Credit hold is the last step before referral to an agency.
4. Disputes and errors → **Credit Note** (controller approval above a set amount).

## 4. Modules (28)

Type codes: T Text, LT Long text, N Number, I Integer, D Date, DT Date/Time, CB Checkbox, S Select, E Email, U URL, P User. **\*** = required. Status options are listed in lifecycle order (→); exception states come after the "|".

**Sales & Estimating**
1. **Customer Account**: Name T\*; Account No T\*; Segment S\* (Retail/Grocery, Restaurant/QSR, Office/Property Mgmt, Healthcare, Education, Industrial, Hospitality, Data/Telecom, Public sector); Payment Terms S\* (Net 30, Net 45, Net 60, COD, Prepay); Credit Limit N; AP Email E; Account Manager P; Status S\* (Prospect → Active | Credit hold, Inactive).
2. **Site**: Site Code T\*; Site Name T\*; Address LT\*; Access Notes LT (roof hatch, lockbox, escort needed); Site Contact T; Service Zone S\* (North, Central, South); After-hours Access CB; Status S (Active | Seasonal, Closed).
3. **Opportunity**: Name T\*; Type S\* (Equipment replacement, New install, Service agreement, Retrofit/Energy, Major repair); Source S (Tech lead from PM, Customer request, Referral, RFP/Tender, Renewal, Website); Est. Value N\*; Expected Close D; Owner P\*; Stage S\* (Qualify → Site survey → Estimating → Proposal sent → Negotiation → Closed won | Closed lost, No decision); Lost Reason S (Price, Budget/timing, Competitor, Chose repair, No response).
4. **Quote**: Quote No T\*; Title T\*; Quote Type S\* (Repair proposal, Equipment replacement, Installation, Service agreement, Parts only); Total N\*; Revision I; Valid Until D\*; Scope of Work LT; Prepared By P\*; Status S\* (Draft → Pending internal approval → Sent → Accepted | Revised, Declined, Expired, Superseded).
5. **Sales Order**: Order No T\*; Order Type S\* (Install, Repair, Parts sale, Agreement start); Order Value N\*; Customer PO T\*; Deposit % N; Requested Date D; Salesperson P; Status S\* (Pending credit check → Confirmed → Equipment ordered → Ready to schedule → In fulfilment → Fulfilled → Invoiced | On hold – credit, Canceled).

**Customer Service & Dispatch**

6. **Service Contract**: Agreement No T\*; Name T\*; Agreement Type S\* (PM only, PM + labor, Full coverage parts & labor, Refrigeration PM + monitoring, T&M priority); Start D\*; End D\*; Annual Value N\*; Billing Frequency S\* (Monthly, Quarterly, Annual in advance); Response SLA S\* (Emergency 4h / routine next business day, Emergency 2h / routine same day, Next business day, Best effort); Coverage Hours S (24/7, M–F 07–17, Extended 06–22); Auto-renew CB; Status S\* (Draft → Pending signature → Active → Renewal due → Renewed | Expired, Canceled, Suspended – non-payment).
7. **Maintenance Plan**: Plan Name T\*; Frequency S\* (Monthly, Quarterly, Semiannual, Annual, Spring/Fall changeover); Checklist Template S\* (RTU quarterly, Split system semiannual, Chiller annual, Walk-in/reach-in monthly, Ice machine sanitize, Cooling tower monthly in season, MUA/exhaust semiannual); Next Due D\*; Generation Horizon (months) I; WO Method S (One WO per site, One WO per asset); Est. Hours N; Status S\* (Draft → Active | Paused, Ended).
8. **Service Request**: SR No T\*; Subject T\*; Symptom S\* (No cooling, No heat, Box temp high, Water leak, Noise/vibration, Alarm/lockout, Ice machine not producing, Burning smell, BMS alarm, Other); Priority S\* (P1 Emergency, P2 Urgent, P3 Routine, P4 Planned); Channel S (Phone, Email, Portal, BMS/remote alarm, Tech-raised); Entitlement S (Under contract, T&M approved, NTE required, Warranty labor, Callback ≤30 days); Not-to-Exceed N; Caller T; Caller Email E; Received At DT\*; Taken By P; Status S\* (New → Triaged → Work order created → Resolved → Closed | Resolved by phone, Duplicate, Canceled by customer).
9. **Work Order**: WO No T\*; Title T\*; Work Type S\* (Emergency repair, Repair, Preventive maintenance, Install/Start-up, Quoted repair, Warranty, Recall/Callback, Leak inspection); Priority S\*; Billing Type S\* (T&M, Contract covered, Contract labor-only, Fixed price quoted, Warranty no charge, Callback no charge); Problem Description LT\*; Resolution Code S; Labor Hours N; Lead Tech P; Completed On DT; Status S\* (Unscheduled → Scheduled → In progress → Completed → Reviewed → Posted/Closed | On hold – parts, On hold – customer approval, Cannot complete, Canceled).
10. **Service Appointment**: Appt No T\*; Technician P\*; Helper P; Scheduled Start DT\*; Arrival Window S (08–12, 12–16, Specific time, After-hours); Actual Arrival DT; Actual Finish DT; Travel Hours N; Cannot Complete Reason S (Parts required, Needs 2nd tech/lift, No access, Customer declined, Out of scope – quote, Weather); Tech Notes LT; Status S\* (Scheduled → Dispatched → Traveling → On site → Completed | Cannot complete, No access, Canceled).

**Field Service**

11. **Asset**: Asset Tag T\*; Customer Tag T (RTU-3); Equipment Type S\* (Rooftop unit, Split system, VRF outdoor unit, Air-cooled chiller, Water-cooled chiller, Cooling tower, Air handler, Fan coil, Walk-in cooler, Walk-in freezer, Reach-in, Ice machine, Refrigeration rack, Condensing unit, Boiler, Make-up air unit, CRAC unit); Make/Model T\*; Serial No T\*; Capacity (tons) N; Refrigerant S (R-410A, R-454B, R-32, R-404A, R-448A, R-449A, R-134a, R-513A, R-744, R-290, R-22 legacy, None); Full Charge (lb) N; Install Date D; Warranty End D; Status S\* (In service → Out of service | Awaiting parts, Decommissioned, Replaced).
12. **Inspection Checklist**: Checklist No T\*; Template S\*; Performed On D\*; Filter S (OK, Replaced, Missing); Coil S (Clean, Cleaned, Heavy fouling – quote); Belts S (OK, Replaced, N/A); Suction psig N; Discharge psig N; Supply Air °F N; Box Temp °F N; Overall Result S\* (Pass, Pass with notes, Deficiency – repair recommended, Fail – red-tagged); Deficiencies LT; Status S (In progress → Submitted → Reviewed).
13. **Refrigerant Log Entry**: Entry No T\*; Transaction S\* (Charge added, Recovered, Leak inspection, Initial verification, Follow-up verification, Recovered for disposal); Refrigerant S\*; Quantity (lb) N\*; Appliance Category S\* (Commercial refrigeration, Comfort cooling, Industrial process); Leak Rate % N; Leak Location S (Evap coil, Cond coil, Braze/flare joint, Schrader core, Compressor, Valve, Not found); Repair Due D; Technician P\*; Cert Type S (Type I, Type II, Type III, Universal [22]); Status S (Recorded → Reviewed → Repair required → Repair verified | Retrofit/retire plan).
14. **Parts Used**: Line Ref T\*; Quantity N\*; Unit Cost N; Unit Price N; Source S\* (Van stock, Warehouse pick, Supplier will-call, Special order); Billable CB; Used By P; Line Status S\* (Estimated → Allocated → Used | Returned to stock, Warranty return pending). The line statuses follow D365 [6] and Salesforce ProductConsumed [12].

**Installation Projects**

15. **Installation Project**: Project No T\*; Name T\*; Contract Value N\*; Retainage % N; Start D; Target Completion D; % Complete N; Permit Required CB; Crane Lift CB; Project Manager P\*; Status S\* (Planning → Submittals/permits → Equipment on order → Scheduled → In progress → Start-up & commissioning → Punch list → Substantially complete → Closed | On hold, Canceled).
16. **Change Order**: CO No T\*; Description LT\*; Reason S\* (Owner request, Unforeseen condition, Inspector/code, Design error, Acceleration); Amount N\* (can be negative); Schedule Impact (days) I; Customer Approver T; Approved On D; Status S\* (Draft → Submitted → Approved | Rejected, Voided).

**Parts & Purchasing**

17. **Part**: Part No T\*; Description T\*; Category S\* (Electrical, Motors, Compressors, Refrigerant, Filters, Belts, Controls, Valves/TXV, Driers & fittings, Gaskets & heaters, Ignition, Consumables); UOM S (Each, lb, Box, Cylinder); Unit Cost N; List Price N; Stock Class S (A van stock, B warehouse, C special order); Qty On Hand N; Reorder Point N; Status S (Active | Superseded, Discontinued).
18. **Stock Location**: Name T\*; Type S\* (Main warehouse, Service van, Install truck, Quarantine/returns); Assigned Tech P; Vehicle Reg T; Last Cycle Count D; Status S (Active | Out of service, Retired).
19. **Stock Transfer**: Transfer No T\*; Type S\* (Van replenishment, Job kit, Van-to-van, Return to warehouse, Defective return); Quantity N\*; Requested By P; Requested On D; Status S\* (Requested → Picked → In transit → Received | Short-shipped, Canceled).
20. **Supplier**: Name T\*; Type S\* (Equipment distributor, Parts wholesaler, Refrigerant supplier, Manufacturer, Crane subcontractor, Electrical subcontractor, Sheet metal fab, Rental); Our Account No T; Payment Terms S; Rep Email E; Ordering Portal U; Approved Vendor CB; Status S (Active | On hold, Inactive).
21. **Purchase Order**: PO No T\*; PO Type S\* (Stock replenishment, Job special order, Project equipment, Subcontract, Warranty replacement); Total N\*; Required By D; Ship Via S (Will-call, Supplier truck, Freight, Courier); Buyer P\*; Approved By P; Status S\* (Draft → Submitted → Approved → Sent → Partially received → Received → Billed → Closed | Canceled). D365 uses Draft/Submitted/Approved/Products Received/Billed/Canceled [7].
22. **Goods Receipt**: GRN No T\*; Received On D\*; Received By P\*; Packing Slip T; Lines Received I; Discrepancy S (None, Short, Damaged, Wrong part, Over-shipped); Status S\* (Received → Put away | Held – discrepancy, Returned to supplier).
23. **Warranty Claim**: Claim No T\*; Claim Type S\* (Parts only, Parts + labor allowance, Unit replacement, Compressor exchange); Failure Date D\*; Failed Part Serial T; Failure Description LT\*; Amount Claimed N; Amount Credited N; Manufacturer Ref T; Status S\* (Draft → Submitted → Info requested → Approved → Part returned → Credited → Closed | Partially approved, Rejected).

**Finance**

24. **Invoice**: Invoice No T\*; Invoice Type S\* (Per job, Contract billing, Progress billing, Retainage release, Parts sale); Invoice Date D\*; Due Date D\*; Amount N\*; Tax N; Balance N; Days Past Due I; Collection Stage S (Current, 1–30 reminder, 31–60 call, 61–90 final notice, 90+ hold/agency); Status S\* (Draft → Pending review → Sent → Partially paid → Paid | Disputed, Written off, Void).
25. **Payment**: Payment Ref T\*; Method S\* (ACH/bank transfer, Check, Card, Lockbox); Received On D\*; Amount N\*; Unapplied N; Applied By P; Status S\* (Received → Applied | Partially applied, Unapplied, Returned/NSF).
26. **Collection Activity**: Activity Type S\* (Reminder email, Phone call, Statement sent, Promise to pay, Dispute logged, Final demand, Credit hold placed, Referred to agency); Contact Date D\*; Outcome LT; Promise Date D; Promised Amount N; Performed By P; Status S (Open → Follow-up due → Resolved).
27. **Credit Note**: CN No T\*; Reason S\* (Rate/billing error, Duplicate invoice, Covered under contract, Warranty labor credit, Goodwill/service failure, Returned parts, NTE exceeded); Amount N\*; Requested By P; Approved By P; Issued On D; Status S\* (Draft → Pending approval → Approved → Applied | Refunded, Rejected).
28. **Supplier Bill**: Vendor Invoice No T\*; Bill Date D\*; Due Date D; Amount N\*; Three-way Match S\* (Matched, Price variance, Qty variance, No receipt); Entered By P; Status S\* (Received → Matched → Approved for payment → Paid | On hold – variance, Disputed).

## 5. Relationships

| # | From → To | Card. | Reason |
|---|---|---|---|
| 1 | Customer Account → Site | 1–N | An account has many locations |
| 2 | Site → Asset | 1–N | Equipment sits at one site |
| 3 | Customer Account → Opportunity | 1–N | Pipeline per customer |
| 4 | Opportunity → Quote | 1–N | Revisions and options |
| 5 | Quote → Sales Order | 1–1 | An accepted quote becomes an order |
| 6 | Sales Order → Installation Project | 1–1 | Install orders run as projects |
| 7 | Installation Project → Change Order | 1–N | Scope changes |
| 8 | Installation Project ↔ Asset | N–N | Units installed or removed |
| 9 | Customer Account → Service Contract | 1–N | Contracts per customer |
| 10 | Service Contract ↔ Site | N–N | Multi-site coverage (chains) |
| 11 | Service Contract → Maintenance Plan | 1–N | A plan per equipment group or frequency |
| 12 | Maintenance Plan ↔ Asset | N–N | Assets covered by the plan |
| 13 | Maintenance Plan → Work Order | 1–N | Generated PM work orders |
| 14 | Site → Service Request | 1–N | Where the fault is |
| 15 | Service Contract → Service Request | 1–N | Entitlement check |
| 16 | Service Request → Work Order | 1–N | Usually 1; a follow-up for a quoted repair |
| 17 | Asset → Work Order | 1–N | Service history (primary asset [5]) |
| 18 | Work Order → Service Appointment | 1–N | Return visits |
| 19 | Work Order → Inspection Checklist | 1–N | PM and start-up records |
| 20 | Work Order → Parts Used | 1–N | Material per job |
| 21 | Part → Parts Used | 1–N | Item consumed |
| 22 | Stock Location → Parts Used | 1–N | Which van gave the part |
| 23 | Asset → Refrigerant Log Entry | 1–N | Leak-rate history per appliance |
| 24 | Work Order → Refrigerant Log Entry | 1–N | Job evidence |
| 25 | Work Order → Quote | 1–N | Repair proposals raised by techs |
| 26 | Part → Stock Transfer; Stock Location → Stock Transfer | 1–N each | Movement of the item to its destination (see note) |
| 27 | Supplier → Purchase Order | 1–N | Vendor |
| 28 | Work Order → Purchase Order | 1–N | Special orders for a job |
| 29 | Purchase Order → Goods Receipt | 1–N | Partial deliveries [7] |
| 30 | Purchase Order → Supplier Bill | 1–N | Usually 1 |
| 31 | Work Order → Warranty Claim; Supplier → Warranty Claim | 1–N each | Failure evidence; the manufacturer |
| 32 | Work Order / Service Contract / Installation Project → Invoice | 1–N each | Per-job, contract and progress billing |
| 33 | Invoice ↔ Payment | N–N | One check can pay many invoices; partial payments |
| 34 | Invoice → Collection Activity; Invoice → Credit Note | 1–N each | Dunning trail; adjustments |

Note on 26: a transfer has two locations (from and to). If OpenSlate cannot link two relationships to the same module, keep only the "to" link and add a "From Location" Select.

## 6. Automations (12)

| # | Event | Condition | Actions |
|---|---|---|---|
| 1 | Service Request created | Priority = P1 Emergency | Create Work Order (Emergency repair, P1, Unscheduled); set SR Status = Work order created |
| 2 | Service Appointment.Status changed | Status = Cannot complete AND Reason = Parts required | Create Purchase Order (Job special order, Draft) |
| 3 | Work Order.Status changed | Status = Reviewed AND Billing Type = T&M | Create Invoice (Per job, Draft) |
| 4 | Work Order created | Work Type = Recall/Callback | Set Billing Type = Callback no charge; set Priority = P2 |
| 5 | Inspection Checklist.Overall Result changed | = Deficiency – repair recommended | Create Quote (Repair proposal, Draft) |
| 6 | Refrigerant Log.Leak Rate % crosses 20 | Appliance Category = Commercial refrigeration | Set Status = Repair required; create Work Order ("Leak repair – 30-day", P2). A twin rule fires at 10 for Comfort cooling (EPA trigger rates 20/30/10% [18]) |
| 7 | Quote.Status changed | = Accepted AND Type = Equipment replacement | Create Sales Order (Pending credit check) |
| 8 | Sales Order.Status changed | = Confirmed AND Type = Install | Create Installation Project (Planning) |
| 9 | Service Contract.Status changed | = Renewal due | Create Opportunity (Service agreement, Qualify, Source = Renewal) |
| 10 | Invoice.Days Past Due crosses 60 | Status = Sent or Partially paid | Set Collection Stage = 61–90 final notice; create Collection Activity (Final demand, Open) |
| 11 | Credit Note created | Amount > 1000 | Set Status = Pending approval |
| 12 | Schedule: weekly, Thursday 14:00 | none | Create Purchase Order (Stock replenishment, Draft, "Weekly stock – main distributor") |

Two assumptions to check:
- Rule 10 needs the simulator to update Days Past Due, because OpenSlate has no formula type.
- Rule 12 assumes a schedule rule creates one record per run.

Supplier Bills that fail three-way match should go to On hold – variance. Add that as a 13th rule if the cap allows.

## 7. Volumes

**Simulation scope (my recommendation).** The whole company produces about 13,000 transaction records a month, so 6,000 records covers less than one month company-wide. That is too short to show PM cycles, collections or warranty credits. Instead, simulate **one service zone (North: 6 service techs, 1 install crew) over 12 weeks (April–June, shoulder season into cooling season)**, with the full back office. Field-driven volume scales by 6/38 × 2.77 months ≈ 0.44. I checked the sums by running them.

| Module | Company / month | Simulated (12 wk) |
|---|---|---|
| Customer Account / Site / Asset (master data) | 650 / 1,400 / 8,500 in total | 110 / 190 / 480 |
| Part / Stock Location / Supplier | 3,200 / 46 / 120 in total | 160 / 10 / 28 |
| Service Contract / Maintenance Plan | 550 / 800 in total | 85 / 120 |
| Opportunity | 125 | 55 |
| Quote | 250 | 110 |
| Sales Order | 90 | 40 |
| Installation Project | 22 | 10 |
| Change Order | 18 | 8 |
| Service Request | 980 | 430 |
| Work Order | 1,420 | 620 |
| Service Appointment | 1,740 | 760 |
| Inspection Checklist | 550 | 240 |
| Refrigerant Log Entry | 215 | 95 |
| Parts Used | 2,240 | 980 |
| Stock Transfer | 195 | 85 |
| Purchase Order | 215 | 95 |
| Goods Receipt | 240 | 105 |
| Supplier Bill | 205 | 90 |
| Warranty Claim | 64 | 28 |
| Invoice | 1,235 | 540 |
| Payment | 1,100 | 430 |
| Collection Activity | 250 | 110 |
| Credit Note | 50 | 22 |
| **Total** | | **6,036** (1,183 master data + 4,853 transactions) |

The simulated asset count covers only assets under contract or touched during the span.

**Ratios (my judgment, anchored to the benchmarks):**
- **Work orders per service request: 0.9.** About 10% of requests close by phone or as duplicates. Monthly work orders = 880 reactive + 480 PM + 60 install, start-up or quoted repair.
- **Visits per reactive work order: 1.3–1.35.** Median first-time fix is 75% [24]. TSIA reports an 87% median for one-visit resolution [23]. Aquant says a failed first visit adds about 2 visits [24]; HVAC techs with van stock recover faster, so I use about 1.35. PM work orders average 1.05–1.1 visits.
- **Parts lines:** about 60% of work orders use parts, at about 2.6 lines each (1.6 lines per work order overall).
- **Inspection checklists:** 1 per PM work order, plus start-ups and leak inspections.
- **Refrigerant entries:** about 15% of work orders.
- **Invoices:** about 80% of reactive work orders are billable (the rest are contract, warranty or callback). Contracts bill 60% monthly, 30% quarterly, 10% annually.
- **Payments:** about 0.9 per invoice at steady state. The simulation has fewer because invoices from the last 4–5 weeks are not yet due on Net 30.
- **Goods receipts:** 1.1 per PO. **Supplier bills:** 0.95 per PO. **Warranty claims:** about 4.5% of work orders. **Credit notes:** about 4% of invoices.

## 8. Status snapshot at the end of the span

| Module | Distribution |
|---|---|
| Service Request | Closed 80%, Work order created (open) 12%, Triaged 2%, New 1%, Duplicate 2%, Canceled 3% |
| Work Order | Posted/Closed 62, Reviewed 6, Completed 8, In progress 3, Scheduled 7, Unscheduled 4, On hold – parts 5, On hold – customer 2, Cannot complete 1, Canceled 2 |
| Service Appointment | Completed 76, Cannot complete 13, Scheduled (future) 5, Dispatched/Traveling/On site 1, No access 1, Canceled 4 |
| Quote | Accepted 38, Sent 22, Declined 14, Expired 12, Superseded/Revised 6, Draft 5, Pending approval 3 |
| Invoice | Paid 64, Sent (not due) 18, Sent overdue 8, Partially paid 4, Draft/Pending review 3, Disputed 2, Void 1 |
| Purchase Order | Closed/Billed 58, Sent 14, Received 10, Partially received 8, Approved 3, Pending approval 3, Draft 2, Canceled 2 |
| Warranty Claim | Credited 35, Submitted 25, Approved 15, Rejected 10, Info requested 8, Draft 7 |
| Service Contract | Active 82, Renewal due 8, Renewed 3, Expired 3, Pending signature 3, Canceled 1 |
| Installation Project (10) | Closed 2, Punch list 1, Start-up 1, In progress 2, Scheduled 1, Equipment on order 2, Planning 1 |

**Progression (share of records created during the span that change status later):**
- Service requests, work orders, appointments and POs: about 95%. A work order averages about 4 transitions.
- Invoices: about 80% (Sent → Paid).
- Quotes: about 70%.
- Warranty claims: about 60%. Manufacturers take weeks to decide.
- Master data: under 5% (asset out of service or replaced, account on credit hold, contract to Renewal due).

Leave the records created in the last 10 days mostly in open states.

## 9. Content vocabulary

The model names and fault codes below are invented. Refrigerant designations are generic, not trademarks.

**Reference formats:** SR-26-01873 · WO-26-04412 · SA-26-04412-2 (2nd visit) · Q-26-0318 Rev B · SO-10452 · PRJ-26-017 · CO-017-03 · AGR-0231 · MP-0231-02 · AST-008812 (plus customer tag "RTU-03") · PO-26-00871 · GRN-26-01120 · TR-26-0219 · WC-26-0044 (manufacturer ref 7731209) · INV-104233 · PMT-260412-07 · CN-000118 · vendor bill SI-5580213.

**Record titles:** "RTU-3 no cooling – 2nd floor east offices"; "Walk-in freezer at 18°F – Store 214"; "Q2 PM – 6 RTUs + 2 splits"; "Ice machine not harvesting – kitchen"; "Water leaking from AHU-1 drain pan onto ceiling tile"; "Replace RTU-2 10-ton (R-22, end of life)"; "Chiller CH-1 low evap temp trips"; "Spring start-up – cooling tower CT-1"; "Leak inspection – rack A, 212 lb R-448A"; "Server room CRAC-2 high temp alarm"; "Reach-in cooler #4 door gasket torn"; "MUA-1 no heat – burner lockout"; "Callback – RTU-5 same fault as WO-26-03980"; "Annual PM agreement renewal – Harbor Clinics"; "Quote: condenser coil replacement RTU-7".

**Equipment models:** Arvant RTX-120G (10-ton gas/electric RTU, R-410A); Arvant RTX-150H (12.5-ton heat pump RTU, R-454B); Coldmere CRS-4 parallel rack (R-448A, 212 lb); Tundrel WIF-812 walk-in freezer with RCU-35 condensing unit (R-404A); Tundrel WIC-610 walk-in cooler; Veltro ACX-150 air-cooled scroll chiller (150 tons, R-454B); Veltro WCX-300 water-cooled screw chiller (R-134a); Brisa VRX-10 VRF outdoor unit (R-32); Halvern AH-8 air handler with VFD; Frostline IM-500 cube ice machine; Norell DSS-3 ductless split (3-ton); Kelso MUA-4 direct-fired make-up air; Pallor CRAC-20 computer-room unit; Avonne BLR-1500 condensing boiler; Ternhill CT-90 cooling tower.

**Symptoms and fault codes:** "E14 high-pressure lockout"; "LPS open – low suction"; "Box temp 47°F, setpoint 36°F"; "Frozen evaporator coil"; "Compressor short-cycling"; "Supply fan not proving (airflow switch)"; "Flame rollout switch open"; "Ignition lockout – 3 tries"; "Defrost termination fault"; "Condenser fan motor seized"; "Economizer stuck open"; "Tripping 40A breaker"; "Ice machine long freeze cycle"; "Condensate overflow – float switch tripped"; "BMS alarm: SAT high"; "Chiller low evap refrigerant temp cutout"; "Door heater failed – frost on frame".

**Resolution codes:** REP-COMP replaced component; ADJ adjusted/calibrated; CLN coil or drain cleaned; RST reset only; NFF no fault found; LEAK-REP leak repaired; RECHG refrigerant charged; TEMP temporary repair, quote to follow; PARTS-ORD parts ordered, return visit; QUOTE referred to quote; WARR warranty repair; CUST customer-caused; NOACC no access; RED red-tagged unsafe; DECL customer declined repair.

**Parts:** Contactor 2-pole 40A 24V coil; Run capacitor 45/5 µF 440V; Condenser fan motor 1/3 HP 1075 RPM 208–230V; V-belt A38; Pleated filter 20x25x2 MERV 8; TXV R-404A 3-ton; Filter drier 3/8 SAE 164 in³; Scroll compressor 5-ton R-410A; High-pressure switch, manual reset; ECM evaporator fan motor 9W; Defrost timer 24h; Walk-in door gasket 30x78; R-448A 25 lb cylinder; Flame sensor; Inducer motor assembly; Condensate pump 115V; Door frame heater 120V; 10K temperature sensor; Ignition control module; Hot-surface igniter.

**Technician notes:**
- "Arr 10:40. RTU-3 locked out on HPS. Cond coil plugged w/ cottonwood. Cleaned coil, reset, ran 30 min, head 385 psig @ 92°F amb. Rec quarterly coil clean."
- "Found cap 45/5 bulged, reads 31 µF on herm side. Replaced from van. Comp amps normal. OK on departure."
- "Comp grounded to case. Needs replacement – ordered via PO-26-00871. Unit tagged out. Store mgr notified (J. Ruiz)."
- "Leak found at braze joint on evap coil outlet. Repaired, pressure tested 150 psig N2 held 30 min, evacuated to 500 microns, charged 6.2 lb R-448A."
- "No access – roof hatch locked, no one on site with key. Left msg w/ facilities."
- "Belts worn/cracked on AHU-1 and 2, replaced A38 x2. Filters replaced. Drain pan slimed, treated."
- "Customer declined coil replacement quote, signed decline on checklist."
- "Red-tagged MUA-1: cracked heat exchanger, CO reading at discharge. Gas valve shut off, owner informed in writing."

**Dispatcher notes:**
- "Caller: store mgr. Walk-in at 47°F, product at risk – P1. Rerouted Marco from PM at Site 0412."
- "Cust requests after 2pm, lunch rush. NTE $750 per PO 44120."
- "2nd call today, upgraded to P1."
- "Moved PM to Thu, tech out sick."
- "Parts ETA Wed from distributor, booked return Thu AM."
- "Callback – same symptom as last week, send same tech."
- "Contract covers labor only, quote parts before install."

## 10. Board content (one quarter)

- **Leadership:** quarterly results and safety stats; new customer win announcement; holiday coverage schedule; "Cooling season readiness" town hall (calendar).
- **Sales:** price list update effective 1 Apr; weekly pipeline review (Tue); distributor product training (calendar); replacement-quote push for R-22 units.
- **Service & Dispatch:** after-hours on-call rota (weekly event); heat-wave surge plan; SLA breach review (monthly); spring start-up campaign kickoff; contract renewals due next 90 days.
- **Field Service:** Monday safety toolbox talk (fall protection on roofs, lockout/tagout, ladder safety); refrigerant regulation update (US ER&R leak-repair dates [19]; EU F-gas intervals [21]); new van stock list; ride-along schedule for apprentices; certification renewals.
- **Installation Projects:** crane lift days (calendar); permit inspection dates; project kickoff posts; commissioning checklist changes.
- **Parts & Purchasing:** quarterly van cycle counts (calendar); supplier price increase notice; refrigerant allocation or price alert; warranty returns pickup days.
- **Finance:** month-end close by working day 5; contract billing run on the 1st; AR aging review every Monday; "submit timesheets by Friday 12:00".

## 11. Access and refusals

| Group (role) | Sales & Est. | CS & Dispatch | Field Service | Install | Parts & Purch. | Finance |
|---|---|---|---|---|---|---|
| Leadership (admin) | all | all | all | all | all | all |
| Sales (member) | manage | read | read | read | read (Part) | none |
| Dispatch & Contracts (member) | read | manage | write | read | read | none |
| Field Techs (member) | read (Site, Quote write) | write (WO, Appt) | write | read | read (Part, Location); write (Stock Transfer) | none |
| Apprentices (member) | none | read | write Checklist, Parts Used; **read** Refrigerant Log | read | read | none |
| Install Crews (member) | read | read | write | write | read | none |
| Parts & Purchasing (member) | read | read | read | read | write (buyers: PO; warehouse: GRN, Transfer, Part; not each other's) | none |
| Finance (member) | read | read | read | read | read | write; Controller manage |
| External Auditor (guest) | none | none | none | none | read | read |

**Segregation of duties:**
- Whoever orders does not receive or pay. Buyers own POs, the warehouse owns receipts, and AP owns supplier bills.
- Whoever bills does not approve their own credits. Credit notes over 1,000 go to the controller (rule 11).
- Only certified technicians write refrigerant records [22].

Limit: OpenSlate grants access per module, not per field. It cannot stop a Sales writer from changing Payment Terms on a Customer Account. If that matters, move credit fields into a Finance-owned module.

**Planned refusals:**
1. A field tech opens INV-104233 to change the labor amount. Finance is hidden (404).
2. An apprentice creates a Refrigerant Log Entry. Refused: the group has read only.
3. A dispatcher sets PO-26-00871 to Approved. Refused: Dispatch has read on Purchasing.
4. A warehouse clerk edits PO quantity after a short shipment. Refused: the clerk must record the discrepancy on the Goods Receipt instead.
5. A buyer enters a supplier bill to speed up payment. Refused: no Finance access.
6. An account manager issues a goodwill credit note. Refused: Finance only.
7. The external auditor edits a Payment. Refused: guests are capped at read.
8. An installer changes a Service Contract's SLA. Refused: Install has read only.

## 12. Cadences and seasonality

**Recurring cadences:**
- **Daily:** 07:00 dispatch huddle; P1 queue; work order review, then invoice run; cash application; van restock requests.
- **Weekly:** Monday safety talk and AR aging; Tuesday pipeline; Thursday stock PO; Friday van replenishment and timesheets.
- **Monthly:** contract billing on the 1st; PM work order generation about the 25th for the next month; statements; A-item cycle counts; SLA review; close by working day 5.
- **Quarterly:** quarterly PM visits; van audits; contract renewals worked 90 days ahead; key-account reviews.
- **Annual:** refrigerant leak inspections (US: 50–500 lb annual, by the 608 rule [18]; EU: ≥5 t CO₂e every 12 months, ≥50 t every 6 months, ≥500 t every 3 months, and double the interval with leak detection [21]); price list update; contract anniversaries; certification tracking. EPA 608 cards do not expire [22].

**Seasonality (Northern Hemisphere; my judgment, consistent with Standard 180 allowing seasonal frequency changes [17]):**
- **Mar–Apr:** spring start-ups and cooling-tower start-up; PM-heavy.
- **May–Sep:** reactive cooling calls peak at about 1.5–2× the winter level; refrigeration faults rise in heat waves; overtime and after-hours calls go up; replacement projects peak.
- **Oct:** fall heating changeover PM.
- **Nov–Feb:** heating calls (boilers, MUA, heat pumps); install backlog and budget-cycle quotes; renewals in January.

The simulated April–June span should show a clear rise in P1 and "No cooling" requests from mid-May.

## 13. Sources

1. APQC PCF cross-industry categories, v7.3.1 (Ardoq summary). https://help.ardoq.com/en/articles/523953-frameworks-resources-apqc-cross-industry-process-classification-framework-v7-3-1
2. APQC, 8.0 Manage Financial Resources definitions (PCF 6.0.0; "Perform revenue accounting" 8.2.1–8.2.5, numbered 9.2 in v7). https://www.apqc.org/sites/default/files/K04087_8.0_Manage_Financial_Resources.pdf
3. Microsoft Learn, D365 Field Service work order lifecycle and statuses (updated Aug 2026). https://learn.microsoft.com/en-us/dynamics365/field-service/work-order-status-booking-status
4. Microsoft Learn, customer agreements overview. https://learn.microsoft.com/en-us/dynamics365/field-service/agreements-overview
5. Microsoft Learn, incident types (tasks, products, resolutions, primary asset). https://learn.microsoft.com/en-us/dynamics365/field-service/configure-incident-types
6. Microsoft Learn, inventory, purchasing and returns (trucks as warehouses, Estimated/Used lines). https://learn.microsoft.com/en-us/dynamics365/field-service/inventory-purchasing-returns-overview
7. Microsoft Learn, create a purchase order (Submitted/Approved, receipts, bills). https://learn.microsoft.com/en-us/dynamics365/field-service/create-purchase-order
8. Microsoft Learn, inspections overview (search summary only). https://learn.microsoft.com/en-us/dynamics365/field-service/inspections-overview
9. Salesforce Trailhead, default work order and service appointment statuses. https://trailhead.salesforce.com/content/learn/projects/modify-the-field-service-center/track-field-service-jobs
10. Salesforce Help, maintenance plans (generation timeframe, WO method; search summary only). https://help.salesforce.com/s/articleView?language=en_US&id=sf.fs_create_maintenance.htm&type=5
11. Salesforce Help, warranty fields (parts/labor/expenses covered; search summary only). https://help.salesforce.com/s/articleView?id=sf.fs_warranty_fields.htm&language=en_US&type=5
12. Salesforce Developers, ProductConsumed (search summary only). https://developer.salesforce.com/docs/atlas.en-us.field_service_dev.meta/field_service_dev/sforce_api_objects_productconsumed.htm
13. ServiceTitan Help, job and appointment statuses (Dispatched/Working/Hold/Done; search summary only). https://help.servicetitan.com/docs/statuses-and-actions-on-jobs-and-appointments
14. (spare; ServiceNow FSM task states seen only in search summaries and not used) https://www.servicenow.com/docs/bundle/yokohama-field-service-management/page/product/field-service-management/concept/work-order-task-states.html
15. Odoo Field Service documentation (search summary only). https://www.odoo.com/documentation/19.0/applications/services/field_service.html
16. US DOE Better Buildings, ANSI/ASHRAE/ACCA Standard 180 overview. https://betterbuildingssolutioncenter.energy.gov/resources/ansiashraeacca-standard-180-standard-practice-inspection-and-maintenance-commercial
17. ANSI/ASHRAE/ACCA Standard 180-2012 (Tables 5-1 to 5-25; RTU Table 5-22 frequencies). https://webstore.ansi.org/standards/ashrae/ansiashraeaccastandard1802012
18. US EPA, stationary refrigeration leak repair requirements (20/30/10% triggers, 30-day repair). https://www.epa.gov/section608/stationary-refrigeration-leak-repair-requirements
19. US EPA, HFC regulatory actions (ER&R: 15 lb threshold; May 2026 TRU exemption proposal). https://www.epa.gov/hfcs/regulatory-actions-managing-hfc-use-and-reuse
20. Jones Day, ER&R final rule summary (Dec 2024; 1 Jan 2026 dates). https://www.jonesday.com/en/insights/2024/12/epas-hfc-emissions-reduction-and-reclamation-program-finalized
21. Regulation (EU) 2024/573, F-gas. https://eur-lex.europa.eu/eli/reg/2024/573/oj/eng (see the caution in the notes below)
22. US EPA, Section 608 technician certification (Types I/II/III/Universal). https://www.epa.gov/section608/section-608-technician-certification
23. TSIA, top KPIs for field service (87% first-visit median, 2021). https://www.tsia.com/blog/top-kpis-for-field-service-organizations
24. Aquant 2025 Field Service Benchmark (157 organizations; first-time fix median 75%, top 86%, bottom 53%). https://www.globenewswire.com/news-release/2025/02/13/3026225/0/en/Aquant-s-2025-Field-Service-Benchmark-Report-Reveals-AI-Enabling-39-Faster-Machinery-Repairs-and-More.html
25. Fieldpoint, first-time fix statistics (secondary; quotes Aberdeen 75%). https://fieldpoint.net/first-time-fix-rates/
26. InvGate, ITIL priority matrix (secondary; impact × urgency). https://blog.invgate.com/itil-priority-matrix
27. WEX FSM, commercial HVAC maintenance contracts (vendor blog; 2–4h emergency SLA practice). https://www.wexfsm.com/blog/commercial-hvac-maintenance-plan-contracts/
28. Procore, AIA G702 application for payment (retainage, schedule of values). https://www.procore.com/library/aia-g702-application-for-payment
