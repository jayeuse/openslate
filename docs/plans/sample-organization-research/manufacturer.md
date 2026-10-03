# Reference manufacturer for the OpenSlate simulation: shelf-stable sauces and condiments plant

**Why this plant.**
- **Clean traceability.** A batch kettle process gives a clear chain from batch to lot to pallet to shipment.
- **Both order types.** Branded retail SKUs are make-to-stock (MTS). Private-label and foodservice SKUs are make-to-order (MTO).
- **A real legal limit.** Most SKUs are acidified foods (pH ≤ 4.6, water activity above 0.85), so there is a legal critical limit to monitor [9][10]. A scheduled-process filing (Form FDA 2541e) also applies; I saw this only in a search result.
- **Two food-safety regimes.** One dry-seasoning line is not acidified, so both regimes show in the data.

## 1. Reference organization profile

| Item | Value (judgment, checked against sources where cited) |
|---|---|
| Headcount | 165: Production 88 (incl. 12 sanitation), Warehouse 18, Quality & Food Safety 17 (incl. 3 product development), Maintenance 12, Sales & CS 9, Planning & Purchasing 7, Finance & Admin 11, Plant leadership 3 |
| Product families | BBQ sauces, ketchup and tomato sauces, salsas, mustards and dressings, hot and wing sauces, relishes, dry seasoning blends |
| SKUs | 180 finished-goods SKUs (110 active; 45 in the simulation); 260 raw and packaging materials |
| Work centers | 4 steam-jacketed kettles (2,000 L) and 1 high-shear tank; L1 hot-fill glass jars; L2 hot-fill PET squeeze bottles; L3 foodservice jugs and pouches; L4 dry blending and pouches (not acidified); case packing and palletizing |
| Shifts | 2 production shifts, 5 days a week; a third shift does sanitation; Saturday overtime in peak season |
| Customers | 140 active: 6 retail chains (delivery to their distribution centers), 12 foodservice distributors, 9 private-label brand owners, the rest regional wholesalers |
| Suppliers | 85 (tomato paste, vinegar, sweeteners, spices, glass, closures, labels, corrugate, maintenance supplies) |
| Output | about 2.5 million units a month (judgment) |

**How it runs day to day.**
- Planning runs MRP on Monday and freezes a one-week schedule.
- Batch makers cook kettle batches. QA techs check pH, Brix and viscosity before a batch goes to a filler.
- Fillers hot-fill and cap each container, then print a code with plant, year, day and period [9]. A metal detector checks each line.
- Every finished lot stays on QA hold until QA reviews the batch and CCP records. Only then is the lot released ("positive release").
- The warehouse ships first-expired, first-out (FEFO) to customer distribution centers.
- Finance values inventory at standard cost and reviews order variances at month end [21].

**Differences by region.**
- **US:** The FDA preventive-controls rule applies: a food safety plan, a qualified person (PCQI) and 2-year record retention [11][13][14]. The acidified-food rules add 3-year records [9][10].
- **FSMA 204 (US traceability rule):** Its lot-code records apply only if the plant processes foods on the Food Traceability List, such as fresh peppers or tomatoes. Enforcement starts on 20 July 2028 [15].
- **EU and UK:** Regulation 178/2002 Art. 18 requires "one step back, one step forward" traceability [16].
- **Retail certification:** Retailers require a GFSI scheme: BRCGS or IFS in Europe, SQF in North America, and FSSC 22000 everywhere [17].
- **Allergens:** The EU and Canada regulate mustard as an allergen; the US does not. This is my judgment and I did not check it again.

## 2. Departments

| Department | Purpose | Lead | Staff titles |
|---|---|---|---|
| Sales & Customer Service | Order intake, pricing, customer specifications | Sales & CS Manager | Customer Service Rep, Key Account Manager, Private Label Coordinator |
| Planning & Purchasing | Master schedule, MRP, scheduling, buying | Supply Chain Manager | Production Planner/Scheduler, Buyer, Materials Planner |
| Warehouse & Logistics | Receiving, storage, cycle counts, shipping | Warehouse Supervisor | Receiver, Forklift Operator, Shipping Clerk, Inventory Controller |
| Production | Batching, filling, packing, shop-floor reporting | Production Manager | Shift Supervisor, Line Lead, Batch Maker, Filler Operator, Packer, Sanitation Lead |
| Quality & Food Safety | Specs, inspections, CCPs, NCRs and CAPAs, documents, audits | QA Manager (PCQI) | QA Technician, Food Safety Coordinator, Document Control Specialist, Product Developer |
| Maintenance & Engineering | Preventive maintenance, breakdown repair, spares, utilities | Maintenance Manager | Maintenance Planner, Mechanic, Electrician/Controls Tech |
| Finance & Admin | Payables and receivables, costing, payroll, HR | Controller | Cost Accountant, AP Clerk, AR Clerk, HR Generalist |

The Plant Manager and an ERP/IT admin are the OpenSlate admins.

## 3. Core processes

The reference frameworks place this work as follows:
- **APQC PCF 7.4:** category 4.0 Manage Supply Chain for Physical Products, and 10.3 Maintain Assets [3].
- **SCOR DS:** the processes Plan, Order, Source, Transform, Fulfill and Return [4].
- **ISA-95 Part 3:** plant-level work is split into production, quality, maintenance and inventory operations [1][2].

**A. Order-to-cash (end-to-end).**
1. The CS Rep enters the Sales Order and its lines from the customer PO. Records: Sales Order, Sales Order Lines.
2. The CS Rep confirms the ship date from stock (MTS) or with the Planner (MTO).
3. For an MTO line, the Planner creates a Production Order.
4. The Shipping Clerk picks released lots FEFO and signs the bill of lading. Record: Shipment.
5. The AR Clerk invoices on shipment and applies the payment. Record: Customer Invoice.

**B. Plan-to-produce (end-to-end).**
1. The Planner runs MRP from open orders and the forecast. This creates Production Orders and purchase needs [7][20].
2. The Planner releases the orders for the frozen week [21].
3. The Batch Maker weighs ingredients, scans material lots and cooks. Record: Batch Record.
4. The QA Tech tests the batch. The tech then releases it to the filler or puts it on hold.
5. The Line Lead logs output, scrap and downtime for each shift [8]. Records: Shift Production Report, Downtime Events, Food Safety Monitoring Logs.
6. QA reviews the records and releases the finished lot [13]. Record: Finished Goods Lot.
7. The Supervisor completes the order. The Cost Accountant reviews the variances [21].

**C. Procure-to-pay (end-to-end).**
1. The Buyer places a PO with a supplier that QA has approved [11].
2. The Receiver checks the trailer seal and the certificate of analysis (COA). The Receiver then books the Material Lot into quarantine.
3. The QA Tech accepts or rejects the lot and changes the lot status [19]. A rejection creates an NCR.
4. The AP Clerk matches the PO, the receipt and the invoice (3-way match) and approves payment.

**D. Issue-to-resolution (end-to-end).**
1. QA opens the nonconformance report (NCR) and contains the product. ISO 9001 clause 10.2 requires this reaction and correction [18].
2. The QA Manager sets the disposition: rework, reprocess, use as is, return to vendor, or destroy.
3. For a recurring or critical issue, QA opens a corrective and preventive action (CAPA). The CAPA records the root cause, the action and the effectiveness check [12][18].
4. If the product has already shipped, the team assesses a recall: Class I, II or III, or a market withdrawal [22].

**E. Maintenance.** Preventive work orders come from a weekly schedule, and breakdowns create corrective orders. The Mechanic repairs, the Line Lead confirms, and QA signs off sanitation before restart. The sign-off step is my judgment of common GMP practice [23].

## 4. Modules (30)

How to read the fields:
- `*` marks a required field.
- A field with no type follows these rules: a name that contains "number", "no" or "code" is Text. A name that contains "date" is Date. Name, Title and Description are Text.
- Status options are listed in lifecycle order. Exception states are in *italics*.
- Links between modules are in section 5, not in the fields.

**Sales & Customer Service**
1. **Customers**:
   - Fields: Name*, Customer code*, Channel* (Select: Retail, Foodservice, Private label, Wholesale, Co-man), Ship-to region (Text), Payment terms (Select: Net 30, Net 45, 2/10 Net 30, Prepaid), Credit limit (Number), Buyer email (Email), Account manager (User).
   - Status (Select): Prospect, Active, *Credit hold*, Inactive.
2. **Sales Orders**:
   - Fields: SO number*, Customer PO* (Text), Order date*, Requested ship date* (Date), Fulfilment type* (Select: Make-to-stock, Make-to-order), Order value (Number), Entered by (User), Notes (Long text).
   - Status* (Select): Draft, Confirmed, Allocated, Partially shipped, Shipped, Invoiced, Closed, *On hold*, *Cancelled*.
3. **Sales Order Lines**:
   - Fields: Line no* (Integer), Customer item code (Text), Qty cases* (Integer), Unit price (Number), Promised date (Date).
   - Line status (Select): Open, Allocated, Backordered, Shipped, *Cancelled*.

**Planning & Purchasing**
4. **Products (finished goods)**:
   - Fields: SKU code*, Description*, Family* (Select: BBQ, Ketchup & tomato, Salsa, Mustard & dressing, Hot & wing, Relish, Dry seasoning), Pack size (Text), Units per case (Integer), Shelf life days* (Integer), Acidified (Checkbox), Allergens (Text), Standard cost per case (Number).
   - Status (Select): Development, Active, Phase-out, Discontinued.
5. **Materials**:
   - Fields: Item code*, Description*, Type* (Select: Ingredient, Packaging – primary, Packaging – secondary, MRO), UoM* (Select: kg, L, ea, roll, case), On-hand qty (Number), Reorder point (Number), Lead time days (Integer), Allergen (Select: None, Milk, Egg, Soy, Wheat, Sesame, Mustard, Fish, Tree nut).
   - Status (Select): Active, Blocked, Obsolete.
6. **Bills of Materials** (the formula) [5][7]:
   - Fields: BOM code*, Version* (Integer), Batch size kg* (Number), Expected yield % (Number), Effective date, Approved by (User).
   - Status* (Select): Draft, Pending approval, Active, Superseded, *Obsolete*.
7. **BOM Lines**:
   - Fields: Seq* (Integer), Phase (Select: Water, Dry, Oil, Acid, Finish, Packaging), Qty per batch* (Number), UoM* (Select), Scrap allowance % (Number), Critical ingredient (Checkbox).
8. **Suppliers**:
   - Fields: Name*, Supplier code*, Category (Select: Ingredient, Packaging, MRO, Service), Contact email (Email), Country (Text), On-time delivery % (Number).
   - Status (Select): Active, Inactive.
9. **Purchase Orders**:
   - Fields: PO number*, Order date*, Due date*, Qty* (Number), Unit price (Number), Buyer (User).
   - Status* (Select): Draft, Sent, Confirmed, Partially received, Received, Closed, *Cancelled*.
   - Assumption: each PO is for one material, which is common for bulk ingredients (judgment).

**Warehouse & Logistics**
10. **Material Lots** (receipts):
    - Fields: Receipt no*, Supplier lot* (Text), Received date*, Qty received* (Number), Best-before (Date), COA received (Checkbox), Trailer seal intact (Checkbox), Location (Text).
    - Status* (Select): Quarantine, Released, *Rejected*, *On hold*, Consumed, Expired.
11. **Shipments**:
    - Fields: BOL number*, Ship date*, Carrier (Text), Pallets (Integer), Trailer condition OK (Checkbox), Seal number (Text), Shipped by (User).
    - Status* (Select): Planned, Picking, Loaded, Shipped, Delivered, *Refused*.
12. **Cycle Counts**:
    - Fields: Count date*, Location* (Text), ABC class (Select: A, B, C), System qty (Number), Counted qty* (Number), Variance (Number), Counter (User).
    - Status (Select): Scheduled, Counted, Recount, Approved, Adjusted.

**Production**
13. **Work Centers**:
    - Fields: Code*, Name*, Type (Select: Kettle, Filling line, Packing, Blending), Rated speed units/min (Number), Shift pattern (Text).
    - Status (Select): Running, Down, Sanitation, Idle.
14. **Production Orders**:
    - Fields: WO number*, Planned qty cases* (Integer), Planned start* (Date/Time), Due date, Completed qty (Integer), Scrap qty (Integer), Priority (Select: Normal, Rush), Planner (User).
    - Status* (Select): Created, Released, In progress, Partially confirmed, Completed, Technically complete, Closed, *On hold*, *Cancelled*.
    - This follows the SAP sequence CRTD, REL, PCNF, CNF, TECO, CLSD [21] and the Odoo sequence Draft, Confirmed, In Progress, Done [6].
15. **Batch Records**:
    - Fields: Batch no*, Kettle* (Select: K1–K4, HS1), Start* (Date/Time), Cook temp °C (Number), Equilibrium pH* (Number), Brix (Number), Viscosity cP (Number), Batch maker (User), QA tech (User), Rework added (Checkbox).
    - Status* (Select): Weighing, Cooking, Awaiting QA, Released to filler, *QA hold*, *Reprocess*, *Destroyed*, Consumed.
16. **Shift Production Reports**:
    - Fields: Date*, Shift* (Select: A, B), Good units* (Integer), Total units* (Integer), Planned min (Integer), Run min (Integer), Scrap units (Integer), OEE % (Number, typed in by the lead), Line lead* (User), Handover notes (Long text), Needs review (Checkbox).
    - Status (Select): Draft, Submitted, Verified.
    - OEE = Availability × Performance × Quality [8].
17. **Downtime Events** [8]:
    - Fields: Start* (Date/Time), Duration min* (Integer), Reason code* (Select, see section 9), Loss category* (Select: Breakdown, Setup/changeover, Minor stop, Reduced speed, Quality loss, Planned), Comment (Long text), Reported by (User).
    - Status (Select): Open, Coded, Reviewed.

**Quality & Food Safety**
18. **Finished Goods Lots**:
    - Fields: Lot code*, Production date*, Best-by date*, Cases produced* (Integer), Cases on hand (Integer), Location (Text), Released by (User), Release date (Date/Time).
    - QA status* (Select): QA hold – awaiting release, Released, *Quality hold*, *Rework*, *Destroyed*, Shipped out, *Recalled*.
19. **Incoming Inspections** [19]:
    - Fields: Inspection date*, Sample size (Integer), COA matches spec (Checkbox), Measured value (Number), Defects found (Text), Inspector* (User).
    - Result* (Select): Pending, Accepted, Accepted with deviation, Rejected.
20. **Food Safety Monitoring Logs**:
    - Fields: Check type* (Select: CCP – pH, CCP – fill temperature, CCP – metal detection, PRP – pre-op sanitation, PRP – allergen changeover, PRP – label verification), Line* (Select: L1–L4), Date/shift* (Date/Time), Reading (Number), Within limit* (Checkbox), Deviation note (Long text), Checked by* (User), Verified by (User).
    - Status (Select): Open, Completed, *Deviation*, Verified.
    - HACCP requires this monitoring and its records [25]. The records must be reviewed within 7 working days [13].
21. **Nonconformance Reports** [12][18]:
    - Fields: NCR no*, Source* (Select: Incoming, In-process, Final, Customer complaint, Audit, Supplier), Defect type* (Select, see section 9), Severity* (Select: Minor, Major, Critical), Qty affected (Number), Containment (Long text), Disposition (Select: Pending, Rework, Reprocess, Use as is – concession, Return to vendor, Destroy), Owner (User).
    - Status* (Select): Open, Contained, Under review, Dispositioned, Closed, *Voided*.
22. **CAPAs**:
    - Fields: CAPA no*, Problem statement* (Long text), Root cause method (Select: 5 Whys, Fishbone, Fault tree), Root cause (Long text), Action plan (Long text), Due date*, Owner* (User), Effectiveness check date.
    - Status* (Select): Open, Root cause, Action in progress, Effectiveness check, Closed – effective, *Reopened*, *Cancelled*.
23. **Customer Complaints**:
    - Fields: Complaint no*, Received date*, Channel (Select: Consumer phone, Retailer, Distributor, Email), Lot code on pack (Text), Category* (Select: Foreign material, Taste/odor, Texture/separation, Package leak/seal, Short fill, Labeling/allergen, Illness claim, Other), Consumer email (Email), Priority (Select: Low, Medium, High, Critical).
    - Status (Select): Received, Investigating, Response sent, Closed – justified, Closed – not justified.
24. **Supplier Approvals** [11]:
    - Fields: Approval type (Select: Initial, Re-approval), Audit/cert scheme (Text), Cert expiry (Date), Risk rating (Select: Low, Medium, High), Approved by (User).
    - Status* (Select): Pending, Approved, Conditional, *Suspended*, Disqualified.
25. **Controlled Documents** [18]:
    - Fields: Doc no*, Title*, Type* (Select: SOP, Work instruction, Specification, Form, HACCP/food safety plan, Policy), Revision* (Integer), Owner (User), Review due (Date).
    - Status* (Select): Draft, In review, Approved, Effective, Superseded, *Obsolete*.

**Maintenance & Engineering**
26. **Equipment**:
    - Fields: Asset tag*, Name*, Criticality (Select: A, B, C), Manufacturer model (Text), Install date, Runtime hours (Number).
    - Status (Select): In service, Down, Out of service, Retired.
27. **Maintenance Work Orders** [23]:
    - Fields: MWO no*, Type* (Select: Preventive, Corrective, Emergency, Calibration, Improvement), Priority (Select: Low, Medium, High, Urgent), Problem/Task* (Long text), Scheduled date, Labor hours (Number), Failure code (Select, see section 9), Technician (User), Sanitation sign-off (Checkbox).
    - Status* (Select): Requested, Approved, Scheduled, In progress, Waiting parts, Completed, Closed, *Cancelled*.

**Finance & Admin**
28. **Supplier Invoices**:
    - Fields: Invoice no*, Invoice date*, Amount* (Number), 3-way match OK (Checkbox), Price variance (Number), Due date, AP clerk (User).
    - Status* (Select): Received, Matched, *Exception*, Approved, Paid, *Disputed*.
29. **Customer Invoices**:
    - Fields: Invoice no*, Invoice date*, Amount* (Number), Deductions (Number), Due date.
    - Status* (Select): Draft, Issued, Partially paid, Paid, *Overdue*, *Disputed*, Credited.
30. **Production Cost Variances** [21]:
    - Fields: Period* (Text, e.g. 2026-10), Standard cost (Number), Actual cost (Number), Material qty variance (Number), Price variance (Number), Scrap variance (Number), Labor/overhead variance (Number), Reviewed by (User).
    - Status (Select): Calculated, Under review, Explained, Posted.

## 5. Relationships

| From → To | Cardinality | Reason |
|---|---|---|
| Customers → Sales Orders | 1:N | Each order has one sold-to customer |
| Sales Orders → Sales Order Lines | 1:N | Order header and its lines |
| Products → Sales Order Lines | 1:N | Each line is for one SKU |
| Sales Order Lines → Production Orders | 1:N | An MTO line drives one or more orders; MTS lines have none |
| Products → Bills of Materials | 1:N | Versions of one formula |
| Bills of Materials → BOM Lines | 1:N | Components |
| Materials → BOM Lines | 1:N | The component item |
| Products → Production Orders | 1:N | What the order makes |
| Work Centers → Production Orders | 1:N | The filling line |
| Production Orders → Batch Records | 1:N | 2–3 kettle batches per order |
| Batch Records ↔ Material Lots | N:M | Forward and backward genealogy; the core traceability link [15][16] |
| Production Orders → Finished Goods Lots | 1:N | A new lot at each shift or code change [9] |
| Finished Goods Lots ↔ Shipments | N:M | "One step forward" [16] |
| Sales Orders → Shipments | 1:N | Partial shipments |
| Shipments → Customer Invoices | 1:1 | Invoice on shipment |
| Suppliers → Purchase Orders | 1:N | The vendor |
| Materials → Purchase Orders | 1:N | Single-material POs |
| Purchase Orders → Material Lots | 1:N | Receipts against a PO |
| Material Lots → Incoming Inspections | 1:1 | One inspection per received lot |
| Purchase Orders → Supplier Invoices | 1:N | 3-way match |
| Suppliers → Supplier Approvals | 1:N | Approval history |
| Work Centers → Shift Production Reports | 1:N | One report per line per shift |
| Shift Production Reports → Downtime Events | 1:N | Losses in that shift |
| Work Centers → Food Safety Monitoring Logs | 1:N | Where the CCP is |
| Nonconformance Reports ↔ Finished Goods Lots, and ↔ Material Lots | N:M | The affected lots |
| Nonconformance Reports ↔ CAPAs | N:M | One CAPA can cover several NCRs |
| Customer Complaints → Nonconformance Reports | 1:1 | A justified complaint escalates to an NCR |
| Work Centers → Equipment | 1:N | Filler, capper, metal detector |
| Equipment → Maintenance Work Orders | 1:N | Asset history |
| Downtime Events → Maintenance Work Orders | 1:1 | A breakdown becomes a corrective order |
| Production Orders → Production Cost Variances | 1:1 | Settled per order |
| Controlled Documents ↔ Products | N:M | Specs and SOPs for each SKU |

## 6. Automations

Each rule has one event, an optional condition and one action.

1. **Threshold-crossed:** Batch Records "Equilibrium pH" crosses above 4.40. This is a plant action limit below the 4.6 legal limit (judgment). Action: set Status to *QA hold*.
2. **Field-changed:** Batch Records "Status". Condition: Status = "QA hold". Action: create an NCR (Source = In-process, Severity = Major, Disposition = Pending).
3. **Record-created:** Finished Goods Lots. Action: set QA status to "QA hold – awaiting release" (positive release).
4. **Field-changed:** Incoming Inspections "Result". Condition: Result = "Rejected". Action: create an NCR (Source = Incoming, Disposition = Return to vendor).
5. **Record-created:** Nonconformance Reports. Condition: Severity = "Critical". Action: create a CAPA (Status = Open).
6. **Record-created:** Customer Complaints. Condition: Category = "Foreign material". Action: set Priority to Critical.
7. **Record-created:** Downtime Events. Condition: Loss category = "Breakdown" and Duration min ≥ 30. Action: create a Maintenance Work Order (Type = Corrective, Priority = High, Status = Requested).
8. **Schedule, weekly, Monday 06:00.** Action: create a Maintenance Work Order (Type = Preventive, Task = "L1 filler: inspect valves, lube cam track", Status = Scheduled). Make one rule for each maintenance route.
9. **Schedule, daily, 05:30.** Action: create a Food Safety Monitoring Log (Check type = PRP – pre-op sanitation, Status = Open). Make one rule for each line.
10. **Field-changed:** Shipments "Status". Condition: Status = "Shipped". Action: create a Customer Invoice (Status = Draft).
11. **Threshold-crossed:** Materials "On-hand qty" crosses below 6. Make one rule for each critical item, for example tomato paste totes. Action: create a Purchase Order (Status = Draft).
    - Limit: a rule compares against a fixed number, so it cannot read each item's own Reorder point field.
12. **Field-changed:** Food Safety Monitoring Logs "Within limit". Condition: Within limit = false. Action: set Status to *Deviation*.

## 7. Volumes (6 weeks, 30 production days, 12 Oct – 20 Nov 2026)

At full plant volume, a whole quarter would need about 12,000 records. Six weeks gives about 6,000. That span still includes one month-end close and the start of the pre-holiday peak.

| Module | Monthly (reference plant) | Simulated | Ratio basis |
|---|---|---|---|
| Customers / Suppliers / Supplier Approvals | 140 / 85 (master records) | 60 / 40 / 40 | The active subset |
| Products / BOMs / BOM Lines | 180 / 110 (master records) | 45 / 45 / 450 | About 10 lines per formula (6 ingredients plus jar, cap, label, case) |
| Materials / Work Centers / Equipment / Documents | Master records | 120 / 8 / 70 / 80 | Documents include about 8 revisions a month |
| Sales Orders / Lines | 200 / 700 | 277 / 970 | 3.5 lines per order |
| Shipments / Customer Invoices | 210 / 210 | 291 / 291 | 1.05 shipments per order (partials); 1 invoice per shipment |
| Purchase Orders / Material Lots / Incoming Inspections / Supplier Invoices | 120 / 160 / 130 / 115 | 166 / 222 / 180 / 159 | 1.3 receipts per PO; 80% of lots inspected (maintenance supplies are not) |
| Production Orders / Batch Records / Finished Goods Lots | 130 / 325 / 180 | 180 / 450 / 249 | 2.5 batches and 1.4 lots per order |
| Shift Production Reports | 168 | 233 | 4 lines × 2 shifts × 21 days |
| Downtime Events | 250 | 346 | About 1.5 events of 5 minutes or more per line-shift |
| Food Safety Monitoring Logs | 378 | 524 | One log per line-shift for each CCP, plus a daily pre-op check; individual readings go inside the log |
| NCRs / CAPAs / Complaints | 25 / 5 / 12 | 35 / 7 / 17 | About 20% of NCRs escalate to a CAPA; about 5 complaints per million units (judgment) |
| Maintenance Work Orders | 170 | 236 | 65% preventive |
| Cycle Counts | 85 | 118 | A items weekly, B monthly, C quarterly |
| Production Cost Variances | 130 | 140 | One per order settled at the one month-end in the span |

Totals: master records 958, transactional records 5,091, **total 6,049**. pH, Brix and viscosity are fields on Batch Records, not separate records. This keeps the CCP paperwork from dominating the count.

## 8. Status distribution (snapshot at the end of the run)

| Module | Share of records in each status | Share that change status later |
|---|---|---|
| Sales Orders | Closed or Invoiced 70%, Shipped 8%, Allocated or Confirmed 15%, Draft 3%, On hold 2%, Cancelled 2% | About 95%, through 3–5 states |
| Production Orders | Closed or Technically complete 72%, Completed 8%, In progress 5%, Released 12%, On hold 1%, Cancelled 2% | All except Cancelled |
| Batch Records | Consumed 93%, Released to filler 3%, QA hold 1.5%, Reprocess 2%, Destroyed 0.5% | All; about 4% leave the normal path |
| Finished Goods Lots | Shipped out 60%, Released 33%, Awaiting release 5%, Quality hold 1.5%, Destroyed 0.5% | 100%, because every lot starts on hold |
| Material Lots | Consumed 55%, Released 38%, Quarantine 4%, Rejected 2%, Expired 1% | About 97% |
| NCRs | Closed 60%, Dispositioned 15%, Under review 15%, Open 10% | 90% |
| CAPAs | Closed – effective 30%, Effectiveness check 30%, Action in progress 30%, Open 10% | All; about 1 in 7 is reopened |
| Maintenance Work Orders | Closed 75%, Completed 8%, Scheduled 8%, Waiting parts 4%, In progress 3%, Cancelled 2% | About 90% |
| Supplier Invoices | Paid 65%, Approved 15%, Matched 10%, Exception 7%, Disputed 3% | About 95% |

All the percentages in this section are my judgment for a stable plant.

## 9. Content vocabulary

**Reference number formats.**
- Orders: SO-26-04817; customer PO 4500123987; WO-26-1842 (production order); PO-26-0912 (purchase order).
- Receiving: R26-10-0412 (receipt); supplier lot TP260915-07.
- Batch: B26-289-K2-03 (year, Julian day, kettle, sequence).
- Finished-goods lot code: **A6289L2B** (plant A, year 6, day 289, line 2, shift B). This follows the code elements in 21 CFR 114.80 [9]. Best-by print: "BEST BY 16 OCT 2027".
- Quality and maintenance: NCR-26-0137; CAPA-26-021; CC-26-0088 (complaint); MWO-26-03412.
- Shipping: BOL-26-06219; an 18-digit SSCC pallet label (GS1 practice; I did not check it again).
- Documents: SOP-QA-014 Rev 7; SPEC-FG-0231; HACCP-PLAN-L1 Rev 4.
- Asset tag: L1-FIL-01.

**Products.**
- BBQ: Smoky Chipotle BBQ Sauce 18 oz glass; Honey Garlic BBQ Sauce 1 gal jug.
- Ketchup and tomato: Classic Tomato Ketchup 20 oz PET; Fancy Ketchup 1.5 kg pouch (foodservice); Pizza Sauce 3 kg pouch.
- Salsa: Medium Chunky Salsa 16 oz jar; Salsa Verde 16 oz.
- Mustard and dressing: Yellow Mustard 14 oz PET; Spicy Brown Mustard 12 oz; Honey Mustard Dressing 12 oz (private label); Sesame Ginger Dressing 12 oz (contains sesame and soy).
- Hot and wing: Buffalo Wing Sauce 1 gal; Chili Garlic Sauce 8 oz.
- Relish: Sweet Pickle Relish 10 oz.
- Dry seasoning (not acidified): Garlic Herb Seasoning 2.5 oz pouch; Taco Seasoning 25 lb bag.

**Materials.**
- Bulk ingredients: tomato paste 31% NTSS in 300 gal aseptic totes; distilled white vinegar 120 grain, bulk; cane sugar, 50 lb bags; corn syrup; fine flake salt.
- Minor ingredients: xanthan gum 80 mesh; modified corn starch; chipotle pepper puree; dehydrated minced onion; granulated garlic; mustard flour; salted egg yolk; soy sauce; toasted sesame seeds; natural smoke flavor.
- Packaging: 18 oz glass jar with 70 mm lug finish; 70 mm lug cap with plastisol liner; 38 mm flip-top closure; pressure-sensitive front label; 12-count RSC case; stretch film.

**Downtime reason codes (loss category in brackets [8]).**
- DT01 Product changeover / allergen wash (Setup)
- DT02 Size changeover (Setup)
- DT03 Filler jam (Minor stop)
- DT04 Capper torque fault (Breakdown)
- DT05 Labeler out of registration (Minor stop)
- DT06 Inkjet coder failure (Breakdown)
- DT07 Metal detector fault or failed test (Quality loss)
- DT08 Waiting on batch – pH retest (Breakdown, line starved)
- DT09 Waiting on packaging (Breakdown, no material)
- DT10 No operator / break coverage
- DT11 Case packer jam
- DT12 Low steam pressure
- DT13 Low compressed air
- DT14 Planned preventive maintenance (Planned)
- DT15 CIP / sanitation (Planned)
- DT16 Quality hold
- DT17 Palletizer fault
- DT18 Power dip

**Maintenance failure codes.** FC01 Bearing wear; FC02 Seal or gasket leak; FC03 Sensor or photo-eye fault; FC04 Belt or chain; FC05 Pneumatic (valve, cylinder); FC06 Electrical or drive; FC07 Lubrication; FC08 Blockage or product buildup; FC09 Operator error or setup; FC10 No fault found.

**Scrap reasons.** Underfill (checkweigher reject); low fill temperature; cocked cap; no vacuum ("dud"); broken glass; skewed label; missing code; metal detector reject; batch pH out of spec; Brix or viscosity out of spec; startup purge; changeover flush; leaking pouch seal; crushed case; expired ingredient; torn or pest-damaged bag.

**Defect types for NCRs and complaints.** Glass, metal, hard plastic or hair; swollen container; mold; loss of vacuum; off-flavor or fermented; separation; color darkening; wrong label; undeclared allergen; missing or illegible code; short fill; leaker; broken tamper band. Most FDA allergen recalls come from labeling errors [24].

**How people phrase notes.**
- "K2 B03 pH 4.08, Brix 31.2, released to L1 10:42."
- "Fill temp dipped to 83 °C ~6 min at 14:10, held 312 cs, QA notified."
- "MD test Fe/NFe/SS all rejected, 11:00 OK."
- "Label roll changed – allergen statement checked vs SPEC-FG-0231, OK."
- "Capper chuck 4 slipping, torque low, MWO raised."
- "Waiting on paste tote, receiving says truck at door 3."
- "Pre-op: residue on filler bowl gasket, re-cleaned, re-swabbed pass."
- "Customer reports glass fragment, lot A6271L1A, retain samples pulled."
- "Short 40 cs on SO-26-04817, backorder to Thu."
- "Allergen wash L2 done, ATP and allergen swab pass, released for honey mustard."
- "Recount bin C-14-02, sugar short 3 bags, adj approved."

The fill temperatures and metal-detector test sizes above are examples only. A real plant takes them from its process authority and its HACCP plan.

## 10. Board content (one quarter)

- **Production**: weekly schedule; toolbox talks (forklift, lockout/tagout, hot surfaces); peak-season overtime sign-up; line trials for new SKUs.
- **Quality & Food Safety**: GFSI certification audit [17]; audit by a private-label customer; mock recall; GMP refresher; allergen changeover reminder after a near miss.
- **Maintenance**: 2-day shutdown in December (boiler inspection, L1 filler rebuild); contractor safety briefing.
- **Warehouse**: holiday carrier cutoffs; quarterly physical inventory; FEFO reminder.
- **Sales**: retailer promotion calendar; private-label launch; date of the price increase.
- **Finance**: month-end close calendar; standard-cost update for next year.
- **Plant-wide**: town hall; safety milestone; holiday production schedule.

## 11. Access and refusals

| Group | Grants |
|---|---|
| Plant leadership (admin) | Everything |
| All member groups | Read: Controlled Documents |
| Operators (member) | Write: Batch Records, Shift Production Reports, Downtime Events, Food Safety Monitoring Logs. Read: Production Orders, Finished Goods Lots |
| Production supervisors | Manage: Production department. Read: Quality department |
| QA | Manage: Quality & Food Safety department. Write: Batch Records, Material Lots (to release from quarantine). Read: all other operations modules |
| Planning & Purchasing | Manage: Planning department. Write: Production Orders. Read: Sales, Warehouse, Supplier Approvals, Supplier Invoices |
| Warehouse | Write: Material Lots, Shipments, Cycle Counts. Read: Finished Goods Lots |
| Sales & CS | Manage: Sales department. Read: Finished Goods Lots, Production Orders, Customer Invoices |
| Maintenance | Manage: Maintenance department. Read: Downtime Events |
| Finance | Manage: Finance department. Read: everything else |
| Auditors (guest) | Read: Controlled Documents, Food Safety Monitoring Logs, CAPAs, Supplier Approvals |

**Separation of duties.**
- QA releases lots; the operator cannot [13].
- Buyers place POs; only AP approves invoices.
- QA approves suppliers [11].
- Only QA makes a document effective [18].

OpenSlate grants apply to a whole module, not to single fields. That is why each separated duty has its own module.

**Refused actions.**
1. The L2 filler operator (read only on Finished Goods Lots) tries to set lot A6289L2B to Released. Denied.
2. The B-shift supervisor (read only on the Quality department) sets the Disposition of NCR-26-0137 to "Use as is". Denied.
3. A buyer (read only on Supplier Invoices) edits an invoice amount to match the PO. Denied.
4. A buyer sets a Supplier Approval to Approved to rush a new spice vendor. Denied.
5. A maintenance tech (read only on Controlled Documents) changes SOP-SAN-006 to Effective. Denied.
6. A CS rep (read only on Production Orders) moves the due date of WO-26-1842 for a key account. Denied.
7. A guest auditor tries to edit a CAPA. Denied, because guests can only read.
   - The same auditor opens Customer Complaints and gets "not found", because the auditor group has no grant for it.
8. A CS rep (read only on Customer Invoices) changes a deduction on an overdue invoice. Denied.
   - A warehouse lead who opens Production Cost Variances gets "not found", because Warehouse has no grant for it.

## 12. Cadences and seasonality

- **Each shift**:
  - CCP monitoring as the HACCP plan sets it [25].
  - pH-meter calibration with buffers.
  - Metal-detector test at start-up, about every 1–2 hours, and at end of shift (judgment).
  - Fill-temperature checks.
  - Shift report and handover.
- **Daily**:
  - Tier meeting.
  - Pre-op sanitation inspection.
  - Receiving and shipping.
  - Lot releases.
  - Record review within 7 working days [13].
- **Weekly**:
  - MRP run and schedule freeze.
  - Preventive maintenance routes.
  - Cycle counts of A items.
  - GMP walk-through.
  - Allergen SKUs run last, before a full wash.
- **Monthly**:
  - Close, inventory valuation and variances [21].
  - OEE and preventive-maintenance compliance (target 90% or more) [23].
  - Supplier scorecards.
- **Quarterly**:
  - Internal audits.
  - Management review (ISO requires at least one a year).
  - Physical counts of B and C items.
- **Annual**:
  - GFSI recertification.
  - Mock recall.
  - Supplier re-approval.
  - Food safety plan reanalysis, at least every 3 years and after major changes [14].

**Seasonality (judgment).**
- **BBQ and wing sauces:** peak from spring to summer, so stock builds from February to May.
- **Salsa:** follows the late-summer pepper and tomato harvest.
- **Dressings, relish and seasonings:** peak before the Q4 holidays.
- **Tomato paste:** packed once a year, so paste contracts and tote stock build in Q3.

**ISO 9001 version.** The ISO committee (TC 176/SC 2) scheduled ISO 9001:2026 for publication on 16 September 2026 [18b]. I could not confirm that it was published, so section 3 uses clause 10.2 of the 2015 edition.

## 13. Sources

1. https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard — ISA-95 Parts 1–8, Levels 0–4, Part 1 edition 2025.
2. https://en.wikipedia.org/wiki/ANSI/ISA-95 — ISA-95 object models and the four plant-level activity areas. Secondary source; the standard itself is paywalled.
3. https://solutions.ifrc.org/sites/default/files/2024-10/K014750_APQC%20Process%20Classification%20Framework%20(PCF)%20-%20Cross%20Industry%20-%20PDF%20Version%207.4.pdf — APQC PCF 7.4 (August 2024), categories 4.1–4.4 and 10.3. The APQC file is hosted by a third party.
4. https://www.ascm.org/globalassets/ascm_website_assets/docs/scor/intro-and-front-matter-scor-digital-standard-2025.pdf — SCOR DS v14.0 (2025), the seven processes.
5. https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/configure_manufacturing_product.html — Odoo bills of materials, operations, work centers, lot tracking.
6. https://www.odoo.com/documentation/saas-19.3/applications/inventory_and_mrp/manufacturing/basic_setup/manufacturing_work_orders.html — Odoo manufacturing-order and work-order states.
7. https://docs.frappe.io/erpnext/user/manual/en/work-order — ERPNext work order fields and statuses, WIP and scrap warehouses.
8. https://www.oee.com/calculating-oee/ and https://www.oee.com/oee-six-big-losses/ — OEE definitions and the six big losses. Vendor education site.
9. https://www.law.cornell.edu/cfr/text/21/114.80 — Acidified foods: pH 4.6 limit and container code marking.
10. https://www.law.cornell.edu/cfr/text/21/114.100 — Acidified-food records, deviations, 3-year retention.
11. https://www.law.cornell.edu/cfr/text/21/117.126 — Parts of a food safety plan, including the supply-chain program and the recall plan.
12. https://www.law.cornell.edu/cfr/text/21/117.150 — Corrective action requirements.
13. https://www.law.cornell.edu/cfr/text/21/117.165 — Verification, record review within 7 working days, calibration.
14. https://www.law.cornell.edu/cfr/text/21/117.170 and https://www.law.cornell.edu/cfr/text/21/117.315 — Reanalysis at least every 3 years; 2-year record retention.
15. https://www.fda.gov/food/food-safety-modernization-act-fsma/fsma-final-rule-requirements-additional-traceability-records-certain-foods — FSMA 204 tracking events and data elements, traceability lot code, 24-hour records, 20 July 2028 date.
16. https://food.ec.europa.eu/horizontal-topics/general-food-law/food-law-general-requirements_en — EU Art. 18 "one step back, one step forward"; Art. 19 withdrawal and recall.
17. https://mygfsi.com/how-to-implement/recognition/certification-programme-owners/ — GFSI-recognised schemes (BRCGS, IFS, SQF, FSSC 22000).
18. https://www.iso9001help.co.uk/10.2-Nonconformity-and-Corrective-Action.html — ISO 9001:2015 clause 10.2: react, find the root cause, keep records. Secondary source; the ISO text is paywalled.
    - 18b. https://committee.iso.org/sites/tc176sc2/home/news/content-left-area/news-and-updates/news-1.html — Final draft approved; publication scheduled for 16 September 2026.
19. https://docs.frappe.io/erpnext/user/manual/en/quality-inspection — Incoming, in-process and outgoing inspections; accept and reject readings.
20. https://docs.frappe.io/erpnext/user/manual/en/production-plan — A production plan built from sales orders creates work orders and material requests.
21. https://community.sap.com/t5/enterprise-resource-planning-q-a/production-order-status/qaq-p/9519453 and https://help.sap.com/docs/SAP_ERP/6fe2dad9dab7486fb4469d13552824f2/1a006053f78c4e3fe10000000a441470-371.html — SAP order statuses (CRTD, REL, PCNF, CNF, DLV, TECO, CLSD) and variance categories (scrap, input price, input quantity, resource usage, lot size). Search-result snippets only; neither page would load.
22. https://www.fda.gov/safety/industry-guidance-recalls/recalls-background-and-definitions — Recall Classes I, II and III, and market withdrawal.
23. https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/maintenance/maintenance_requests.html — Corrective and preventive maintenance requests and their stages. The 90% compliance target is SMRP metric 5.4.14 as quoted by maintenance-software vendors; I did not get the SMRP text.
24. https://www.fda.gov/food/hfp-constituent-updates/fda-releases-two-new-chapters-draft-guidance-preventive-controls-human-food-rule — FDA allergen program chapter (September 2023): labeling errors cause most allergen recalls. Search-result snippet only; the page was not fetched.
25. https://www.fda.gov/food/hazard-analysis-critical-control-point-haccp/haccp-principles-application-guidelines — FDA/NACMCF HACCP Principles (1997): the 7 principles, CCP, critical limit, monitoring, prerequisite programs.
