# FMCG distributor reference model for OpenSlate simulated data

**Status: complete.** This is based on primary process frameworks (APQC PCF 7.4, the SAP Direct Store Delivery application help, and the Salesforce Consumer Goods data model), regulator pages, and benchmarks from vendors that sell distributor management software (DMS). Nothing I found gives the headcount or outlet count of a typical distributor. I built those from sourced ratios, so they are my judgment. The volumes, status shares, naming, board content and seasonality are also my judgment unless a citation is given.

**Type legend for section 4:**
- Field types: T = Text, LT = Long text, N = Number, I = Integer, D = Date, DT = Date/Time, Chk = Checkbox, Sel = Select, Em = Email, URL, Usr = User.
- `*` marks a required field. `→X` means the field is a link to module X (see section 5).
- Money is N, with the currency in the field name.

---

## 1. Reference organization profile

**"Harborline Trading" (invented name).** A regional distributor for about 12 principals, with around 1,100 active SKUs. It runs one main warehouse of about 2,500 pallet positions and one satellite depot or cross-dock. Headcount is about 120. The sales team has 10 pre-sellers, 8 van sellers, 3 key-account reps and 3 sales supervisors. Logistics has 12 delivery trucks and a fleet of about 20 vehicles. Warehouse staff number about 25. Finance and admin number about 15.

The outlet universe is about 4,200 active outlets. About 3,600 are general trade (sari-sari stores, kiosks, small groceries, market stalls), about 350 are pharmacies and drugstores, and about 60 are modern-trade branches. All figures are judgment. They are sized so the sourced ratios below close. For scale, a single weekly beat holds 50 to 100 outlets, and an urban pre-seller makes 30 to 45 calls a day [9][11].

**How it runs day to day.** The distributor buys from principals with purchase orders. The principal's invoice to the distributor is the "primary sale". The distributor's sale to retailers is the "secondary sale" [12]. The secondary-sales ledger is the basis for principal reporting and for scheme claims [16].

Pre-sellers follow a fixed permanent journey plan (PJP) and book orders on a handheld. The warehouse picks FEFO (first expired, first out) overnight [19], and trucks deliver the next day. This is the "book today, deliver tomorrow" model [8].

Van sellers work differently. Each loads a speculative stock load in the morning (check-out). They sell, invoice and collect at the door, then check in the unsold stock, returns and cash at day-end. Route accounting then settles the day [4]. Finance chases credit accounts, and the claims desk recovers scheme, bad-order and price-difference money from principals [15][18].

**Regional differences (sourced):**

| Region | Difference |
|---|---|
| Philippines | Sari-sari stores took about 36% of FMCG peso sales in 2014. Each store serves about 20 households and carries up to 200 SKUs [14]. Since RR 7-2024, the **invoice** replaced the official receipt as the primary sales document [29]. |
| India | Goods moving above ₹50,000 need a GST e-way bill. Some states set ₹1 lakh for intra-state moves, and returns also need one [30]. |
| Kenya | Most volume moves through key distributors that redistribute to dukas [13]. All businesses must issue eTIMS electronic tax invoices [31]. |
| UK | Wholesale reaches about 72,000 independent grocers through cash-and-carry and delivered wholesale [32]. Van pre-sell to tiny outlets is rare there. |
| US | Broadline convenience distributors serve c-stores at scale. One distributor serves 13,500 locations [33]. |
| Morocco (study) | A study in Casablanca found pre-sales gave higher volume and about 25% lower distribution cost in dense areas. Van sales win where outlets are far apart [7]. |

**Regional differences (judgment, not sourced):** post-dated cheques are common for credit collection in the Philippines and India. M-Pesa paybill collections are common in Kenya.

## 2. Departments

| Department | Purpose | Lead / staff titles |
|---|---|---|
| Sales (route-to-market) | Outlet coverage, PJP, pre-sell and van sales | Sales Manager; Area Sales Supervisor; Pre-seller (also called DSR, distributor sales representative); Van Salesman; Merchandiser |
| Key Accounts & Trade Marketing | Modern-trade listings, promotions, display contracts | KA & Trade Marketing Manager; Key Account Executive; Trade Marketing Officer |
| Purchasing & Principal Relations | Replenishment, item master, principal scorecards | Purchasing Manager; Purchasing Officer; Master Data Assistant |
| Warehouse & Inventory | Receiving, putaway, FEFO picking, counts, returns and bad orders | Warehouse Manager; Inventory Controller; Receiving Checker; Picker/Loader; Returns (BO) Clerk |
| Logistics (Dispatch & Fleet) | Trip planning, delivery, proof of delivery, vehicle upkeep | Logistics Supervisor; Dispatcher; Driver; Delivery Helper |
| Credit & Collections | Credit limits, AR, receipts, collection follow-up | Credit & Collections Manager; Credit Analyst; Collector; Cashier |
| Accounting & Claims | Principal invoices (AP), claims, month-end close | Finance Controller; AP Accountant; Claims Officer |

## 3. Core processes

Process IDs map to the APQC PCF 7.4 [1]. The steps follow the SAP DSD application help [4], except where a note says otherwise.

**A. Order-to-cash, pre-sell (end-to-end).** PCF 3.5.4, 9.2.1–9.2.4.
1. The pre-seller visits the outlet on the PJP day. They check the shelf and enter the order with the scheme applied. The records are a Store visit and a Sales order with its lines.
2. The system checks credit, and the credit analyst releases or holds the order. Order status becomes Confirmed or Credit hold.
3. Warehouse staff allocate and pick by FEFO, and a checker verifies the load. The order moves to Allocated, then Picked.
4. The dispatcher plans the trip. The driver delivers and prints the invoice or delivery receipt, records shortages and picks up returns [4][8]. The records are a Delivery trip, a Sales invoice and possibly a Return.
5. The cashier or collector posts cash on delivery, or the invoice ages to its due date. The record is a Collection receipt.
6. The collector follows up overdue accounts. The credit manager suspends accounts or writes off balances (PCF 9.2.1.7, 9.2.4.5). The record is a Collection follow-up.

**B. Van sales (end-to-end, cash-led)** [4].
1. Start of day: the van salesman records the vehicle and odometer.
2. Check-out: the salesman counts the load and cash float, and a warehouse checker signs. The record is a Route tour with status Checked out.
3. Visits: the salesman sells from the van, prints the invoice and collects payment, or records a no-visit or no-order reason code. The records are a Store visit, a Sales invoice (channel Van) and a Collection receipt.
4. Check-in: the salesman counts returned stock, damaged goods and bad orders, and a supervisor confirms.
5. End of day: the salesman remits cash. The cashier reconciles loaded stock against sales plus returns, and invoices against cash [28]. The Route tour becomes Settled, or Variance if the numbers differ.

**C. Procure-to-pay with principals (end-to-end).** PCF 4.2.3, 4.4.3.2, 9.6.1.
1. The purchasing officer builds a suggested order from stock cover and sales. The record is a Purchase order with status Draft.
2. The finance controller or GM approves (a segregation-of-duties control [24][25]). The officer then sends the PO to the principal.
3. The principal delivers. The receiving checker counts against the PO and records the lot number and expiry per line. The records are a Goods receipt and Stock lots.
4. The AP accountant three-way matches the PO, the goods receipt and the principal invoice [25]. Then they approve payment (PCF 9.6.1.4).

**D. Trade promotion to claim (end-to-end).** PCF 3.3.4, 9.2.5.
1. The principal issues a scheme circular. The trade marketing officer sets up a Trade promotion: free goods such as "12+1", a quantity purchase scheme (QPS), a value purchase scheme (VPS), or a display allowance [11][35].
2. Sales apply the scheme on orders. Off-invoice value comes off the invoice price [17].
3. At the end of the period, the claims officer compiles proof: scheme sales from secondary data, signed outlet acknowledgments and display photos. They then submit a Principal claim [15][16].
4. The principal validates the claim, approves it fully or partly, or rejects it, and settles it by credit note or offset against payables. A chargeback is how a distributor recovers the price difference from a manufacturer [18].

**E. Returns and bad orders (BO) to principal recovery.** PCF 6.2.4, 4.4.2.4.
1. The pre-seller or driver records the outlet's return with a reason code. The record is a Return with status Requested.
2. The supervisor authorizes. The driver picks up the goods and issues a pickup slip.
3. The BO clerk inspects and sets a disposition: resaleable, return to principal, or destroy.
4. The credit analyst issues a credit memo or replacement.
5. The claims officer files a return claim with the principal [15].

"Bad order (BO)" is the Philippine trade term. My sourcing for it is thin: one Philippine SME blog [34]. The generic terms are "market returns" or "unsaleables".

**F. Inventory control.** PCF 4.4.3.5.
1. The inventory controller runs ABC cycle counts: A items monthly, B quarterly, C yearly [27].
2. The controller investigates any variance and raises a Stock adjustment. The finance controller approves it.
3. The controller moves near-expiry lots to a pick-first status or blocks them. Retailers often want at least about two-thirds of the shelf life left on delivery (the minimum life on receipt, MLOR, rule) [20].

## 4. Modules (26)

**Sales**
1. **Outlet**: Outlet name* T; Outlet code* T; Channel* Sel (Sari-sari/Small grocery, Pharmacy/Drugstore, Minimart/Convenience, Supermarket (MT), Wholesaler/Market stall, Carinderia/Food service); Outlet class* Sel (A, B, C); Beat →Beat; Owner/contact T; Phone T; Address LT; Payment terms* Sel (Cash on delivery, 7 days, 15 days, 30 days); Credit limit (PHP) N; Account status* Sel (Prospect, Active, On credit hold, Blocked, Inactive, Closed). Class sets visit frequency: A weekly, B every two weeks, C monthly [9]. The Salesforce Retail Store object models the same attributes: store type, priority, payment method, delivery frequency [6].
2. **Beat**: Beat code* T (for example "PS04-TUE"); Salesman* Usr; Route type* Sel (Pre-sell, Van sales, Key account); Visit day* Sel (Mon–Sat); Planned outlets I; Territory T; Status* Sel (Draft, Active, Under review, Retired).
3. **Store visit**: Outlet* →; Salesman* Usr; Planned date* D; Check-in time DT; Check-out time DT; Visit outcome* Sel (Productive, No order, Not visited); No-order reason Sel (see section 9); Shelf notes LT; Status* Sel (Planned, In progress, Completed, Abandoned). These statuses are the Salesforce Visit statuses [5].
4. **Sales order**: Order no.* T; Outlet* →; Pre-seller* Usr; Order date* D; Requested delivery D; Channel* Sel (Pre-sell, Key account, Phone/WhatsApp); Order total (PHP)* N; Payment terms Sel; Scheme applied Chk; Status* Sel (Draft, Submitted, Credit hold, Confirmed, Allocated, Picked, Dispatched, Delivered, Partially delivered, Invoiced, Closed, Cancelled, Rejected by credit).
5. **Sales order line**: Order* →; Product* →; Qty (cases) N; Qty (pieces) I; Unit price N; Discount % N; Free goods qty I; Line total N; Line status Sel (Open, Allocated, Short-shipped, Delivered, Cancelled).
6. **Route tour** (a van day, following the SAP tour [4]): Tour no.* T; Van salesman* Usr; Vehicle* →; Tour date* D; Load value (PHP) N; Sales value (PHP) N; Cash remitted (PHP) N; Cash variance (PHP) N; Stock variance (cases) N; Status* Sel (Planned, Checked out, In progress, Checked in, Settled, Variance under review, Cancelled).

**Key Accounts & Trade Marketing**
7. **Trade promotion**: Scheme code* T; Principal* →; Scheme type* Sel (Free goods (Buy X get Y), Off-invoice discount, QPS, VPS, Display allowance, Bill-back, Lump sum/listing fee) [11][17][35]; Mechanics* LT; Start date* D; End date* D; Eligible channels T; Budget (PHP) N; Claim deadline D; Status* Sel (Draft, Pending principal approval, Approved, Active, Ended, Claimed, Cancelled).
8. **Display agreement**: Agreement no.* T; Outlet* →; Promotion →; Display type* Sel (Shelf strip, End-cap/gondola, Chiller placement, Hanger/strip display, Window banner); Monthly fee (PHP) N; Start D; End D; Photo audit passed Chk; Status* Sel (Proposed, Signed, Active, Audit failed, Ended, Terminated).

**Purchasing & Principal Relations**
9. **Principal**: Name* T; Principal code* T; Category* Sel (Packaged food, Beverages, Personal care, Home care, Dairy, OTC/health); Account manager T; Email Em; Portal URL; Payment terms Sel (30, 45, 60 days); Status* Sel (Onboarding, Active, On hold, Terminated).
10. **Product**: SKU code* T; Description* T; Principal* →; GTIN (each) T; GTIN (case) T (GTIN-13 for the each, GTIN-14 for the case [21]); Pieces per case* I; List price per case (PHP)* N; Shelf life (days)* I; ABC class Sel (A, B, C); Status* Sel (New/listing, Active, Phase-out, Delisted, Recalled).
11. **Purchase order**: PO no.* T; Principal* →; Raised by* Usr; PO date* D; Expected delivery D; PO total (PHP)* N; Approver Usr; Status* Sel (Draft, Pending approval, Approved, Sent to principal, Partially received, Received, Closed, Rejected, Cancelled).
12. **PO line**: PO* →; Product* →; Qty ordered (cases)* N; Qty received (cases) N; Unit cost N; Line status Sel (Open, Partially received, Received, Short-closed).

**Warehouse & Inventory**
13. **Goods receipt (GRN)**: GRN no.* T; PO* →; Received by* Usr; Received at* DT; Principal DR/invoice ref T; Pallet SSCC T (18 digits [22]); Discrepancy Chk; Discrepancy note LT; Status* Sel (Draft, Counting, Posted, Posted with discrepancy, Reversed).
14. **Stock lot**: Lot/batch no.* T; Product* →; GRN →; Expiry date* D; Qty on hand (cases) N; Bin location T; Expiry band* Sel (>180 days, 91–180 days, 31–90 days (near expiry), ≤30 days (critical), Expired); Lot status* Sel (Available, Pick first (FEFO), Quarantine, Blocked, Returned to principal, Depleted).
15. **Stock count**: Count no.* T; Product* →; Count type* Sel (Cycle A, Cycle B, Cycle C, Full stock take, Spot check); Counted by* Usr; System qty N; Counted qty N; Variance % N; Status* Sel (Scheduled, Counted, Recount required, Approved, Posted).
16. **Stock adjustment**: Adj no.* T; Product* →; Lot →; Qty (cases, +/−)* N; Value (PHP) N; Reason* Sel (see section 9); Requested by* Usr; Approved by Usr; Status* Sel (Draft, Pending approval, Approved, Posted, Rejected).
17. **Return (BO)**: Return no.* T; Outlet* →; Source invoice →; Reported by* Usr; Pickup date D; Return value (PHP) N; Disposition Sel (Restock, Return to principal, Destroy/dispose, Replace); Status* Sel (Requested, Authorized, Picked up, Received, Inspected, Credited, Replaced, Rejected, Cancelled).
18. **Return line**: Return* →; Product* →; Lot no. T; Qty (pieces) I; Reason code* Sel; Condition Sel (Sealed/resaleable, Damaged, Expired, Leaking/contaminated).

**Logistics**
19. **Delivery trip**: Trip no.* T; Vehicle* →; Driver* Usr; Helper Usr; Trip date* D; Drops planned I; Drops completed I; Status* Sel (Planned, Loading, Dispatched, In transit, Returned to depot, Closed, Cancelled).
20. **Vehicle**: Plate no.* T; Type* Sel (Van 1-ton, Truck 4-wheel, Truck 6-wheel, Motorcycle); Capacity (cases) I; Registration expiry D; Next PMS (preventive maintenance) due D; Odometer I; Status* Sel (Available, On trip, Under maintenance, Out of service).

**Credit & Collections**
21. **Sales invoice**: Invoice no.* T; Outlet* →; Order →; Route tour →; Channel* Sel (Pre-sell, Van, Key account); Invoice date* D; Due date* D; Amount (PHP)* N; Balance (PHP) N; Days past due I; Aging bucket Sel (Current, 1–30, 31–60, 61–90, 90+) [23]; Status* Sel (Open, Partially paid, Paid, Overdue, Disputed, Written off, Cancelled/voided).
22. **Collection receipt**: Receipt no.* T; Outlet* →; Collected by* Usr; Receipt date* D; Amount (PHP)* N; Method* Sel (Cash, Cheque, Post-dated cheque, Bank transfer, E-wallet); Cheque/ref no. T; Status* Sel (Recorded, Remitted, Deposited, Cleared, Bounced, Voided).
23. **Credit review**: Outlet* →; Requested by* Usr; Requested limit (PHP) N; Approved limit (PHP) N; Terms requested Sel; Review type* Sel (New account, Limit increase, Periodic review, Reinstatement); Decision note LT; Status* Sel (Submitted, Under review, Approved, Approved with conditions, Declined).
24. **Collection follow-up**: Outlet* →; Invoice →; Assigned to* Usr; Action* Sel (Call, Visit, Statement sent, Demand letter, Endorse to legal); Promise-to-pay date D; Outcome LT; Status* Sel (Open, Promise to pay, Paid, Escalated, Closed – uncollectible).

**Accounting & Claims**
25. **Principal invoice (AP)**: Principal invoice no.* T; Principal* →; PO →; Invoice date* D; Amount (PHP)* N; Match result Sel (3-way matched, Qty variance, Price variance, No GRN); Status* Sel (Received, Matching, On hold – variance, Approved for payment, Paid, Disputed).
26. **Principal claim**: Claim no.* T; Principal* →; Claim type* Sel (Scheme/promo, BO/expiry return, Price difference/chargeback, Display allowance, Short/damaged delivery, Logistics/freight subsidy) [15][18]; Period D; Claimed (PHP)* N; Approved (PHP) N; Rejection reason Sel; Filed by* Usr; Status* Sel (Draft, Submitted, Under principal review, Approved, Partially approved, Rejected, Settled – credit note, Settled – offset, Written off).

**Modeling gaps in OpenSlate, and how I handled them:**
- There is no formula field type. Days past due, Aging bucket, Expiry band, Variance % and Cash variance must therefore be set by a person or by the generator. They are stored fields.
- Access is set per department or module, not per record or field. Section 11 works around this.

## 5. Relationships

| # | Link | Cardinality | Reason |
|---|---|---|---|
| 1 | Beat → Outlet | 1:N | An outlet sits on one PJP beat |
| 2 | Outlet → Store visit | 1:N | Visit history |
| 3 | Outlet → Sales order | 1:N | Secondary sales per outlet |
| 4 | Sales order → Sales order line | 1:N | Order detail |
| 5 | Product → Sales order line | 1:N | SKU sold |
| 6 | Store visit → Sales order | 1:1 | A productive pre-sell call yields one order |
| 7 | Sales order → Sales invoice | 1:N | Partial deliveries can invoice separately |
| 8 | Route tour → Sales invoice | 1:N | Van invoices belong to the day's tour |
| 9 | Route tour → Store visit | 1:N | Van visits in the tour |
| 10 | Delivery trip ↔ Sales order | N:M | A trip carries many orders; a failed drop re-ships |
| 11 | Vehicle → Delivery trip / Route tour | 1:N | Fleet use |
| 12 | Sales invoice ↔ Collection receipt | N:M | A statement payment clears many invoices; a partial pays one |
| 13 | Outlet → Credit review | 1:N | Limit history |
| 14 | Sales invoice → Collection follow-up | 1:N | Dunning trail |
| 15 | Outlet → Return | 1:N | Bad orders per outlet |
| 16 | Return → Return line; Product → Return line | 1:N | Return detail |
| 17 | Principal → Product | 1:N | Item ownership |
| 18 | Principal → Purchase order → PO line | 1:N | Primary orders |
| 19 | Purchase order → Goods receipt | 1:N | Split deliveries |
| 20 | Goods receipt → Stock lot | 1:N | Lot and expiry captured at receipt |
| 21 | Product → Stock lot / Stock count / Stock adjustment | 1:N | Inventory by SKU |
| 22 | Principal → Trade promotion | 1:N | Scheme source |
| 23 | Trade promotion ↔ Sales order | N:M | Schemes applied |
| 24 | Outlet → Display agreement; Trade promotion → Display agreement | 1:N | Paid display |
| 25 | Principal claim ↔ Trade promotion / Return | N:M | Claim support |
| 26 | Purchase order → Principal invoice | 1:N | 3-way match |

## 6. Automations

Each rule sets a field on the record that triggered it, or creates a follow-up record.

1. **Credit hold on large credit orders.** Record created: Sales order. Condition: Payment terms ≠ Cash on delivery and Order total ≥ 50,000. Action: Status = Credit hold.
2. **PO approval gate.** Record created: Purchase order. Condition: PO total ≥ 500,000. Action: Status = Pending approval.
3. **Receiving discrepancy becomes a claim.** Field changed: Goods receipt Status → Posted with discrepancy. Action: create Principal claim (Type = Short/damaged delivery, Status = Draft).
4. **BO to principal.** Field changed: Return Status → Inspected. Condition: Disposition = Return to principal. Action: create Principal claim (Type = BO/expiry return, Draft).
5. **Near expiry means pick first.** Field changed: Stock lot Expiry band → 31–90 days. Action: Lot status = Pick first (FEFO).
6. **Expired stock is blocked.** Field changed: Stock lot Expiry band → Expired. Actions: Lot status = Blocked, and create Stock adjustment (Reason = Expired – write-off, Status = Pending approval).
7. **Aging to follow-up.** Threshold crossed: Sales invoice Days past due crosses 30. Actions: Aging bucket = 31–60, and create Collection follow-up (Action = Call, Status = Open).
8. **Serious arrears.** Threshold crossed: Days past due crosses 90. Actions: Aging bucket = 90+, and create Collection follow-up (Action = Demand letter).
9. **Dispute handling.** Field changed: Sales invoice Status → Disputed. Action: create Collection follow-up (Action = Visit).
10. **Van cash shortage.** Threshold crossed: Route tour Cash variance crosses below −500. Action: Status = Variance under review.
11. **Count tolerance.** Threshold crossed: Stock count Variance % crosses 2. Action: Status = Recount required.
12. **Weekly A-item count.** Schedule: weekly, Monday 07:00. Action: create Stock count (Count type = Cycle A, Status = Scheduled).

The OpenSlate rule model has one limit here. Days past due and Expiry band must be maintained by someone, because there is no formula field. The generator must update them over simulated time so that rules 5–8 fire.

## 7. Volumes

**Real monthly volume for the whole reference organization.** This assumes 24 selling days and a 6-day week (judgment).
- Store visits:
  - Pre-sell visits: 10 pre-sellers × 34 calls × 24 days ≈ 8,160 [9][11].
  - Van visits: 8 van sellers × 28 calls × 24 days ≈ 5,376.
  - Total visits: about 13,500.
- Productive-call rate: 60–75% by DMS vendor benchmarks, corroborated by a second vendor [9][10]. I used 65% for pre-sell and 70% for van.
- Orders and invoices:
  - Pre-sell orders: about 5,300.
  - Key-account orders: about 400.
  - Van invoices: about 3,760.
  - Total invoices: about 9,400.
- Lines per order:
  - Pre-sell: about 4 lines per order (vendor range 2.5–5 [9]).
  - Key account: about 18 lines per order (judgment).
  - Total order lines: about 28,400, excluding van lines.
- Delivery trips: 12 trucks × 24 days = 288 trips, which gives about 20 drops per trip.
- Van tours: 192.
- Collection receipts: about 7,000.
- Returns: about 700.
- Purchase orders: about 70, at about 25 lines each.
- Goods receipts: about 80.
- Cycle counts: about 360. This comes from 1,100 SKUs split A/B/C and counted monthly, quarterly and yearly [27].
- Principal claims: about 36.
- New trade promotions: about 45.

**The 6,000-record budget cannot hold a quarter at full fidelity.** Order lines alone would be about 85,000. I propose three tiers over **one quarter (13 weeks, 78 selling days)**:

| Tier | Scope | Modules and counts |
|---|---|---|
| Master data (786) | Trimmed to the records the sample references | Principal 12, Product 300, Outlet 440, Beat 18, Vehicle 16 |
| Front line, 1:50 sample (4,034) | Retail-facing activity | Store visit 840, Sales order 340, Sales order line 1,560, Route tour 12, Delivery trip 17, Sales invoice 555, Collection receipt 455, Return 45, Return line 110, Credit review 30, Collection follow-up 70 |
| Back office, about 1:2 to 1:6 (1,180) | Principal-facing and inventory work | Trade promotion 60, Display agreement 40, Purchase order 55, PO line 330, Goods receipt 62, Stock lot 300, Stock count 180, Stock adjustment 45, Principal invoice 60, Principal claim 48 |

**Total: 6,000 records** (checked by script).

**Ratios inside the sample:**
- Productive calls: (340 orders + 225 van invoices) / 840 visits = 67%.
- Lines per order: 4.6.
- Invoices: 330 pre-sell and key account (about 3% cancelled or held) plus 225 van.
- Receipts: 225 van cash + about 190 cash on delivery + about 40 statement payments = 0.82 receipts per invoice.
- Drops per trip: about 20.
- Van invoices per tour: about 19.
- PO lines: about 6 per PO. This is only the lines on the 300 sampled SKUs, out of about 25 real lines.
- Stock lots: about 1 per GRN line.
- Follow-ups: about 34 overdue credit invoices × 2 touches = 70.

**Caution:** dashboard totals on this data are scaled samples. The ratios are realistic, but the absolute values are not.

## 8. Status distribution at quarter end (judgment)

About 45% of all records should show at least one status change in their history.

| Module | Snapshot shares | Records with history |
|---|---|---|
| Sales order | Closed/Invoiced 82%, Delivered not invoiced 4%, Confirmed/Allocated/Picked 5%, Credit hold 2%, Partially delivered 2%, Cancelled 4%, Rejected by credit 1% | ~95% (4–6 transitions each) |
| Sales invoice | Paid 68%, Open 14%, Partially paid 6%, Overdue 9%, Disputed 2%, Written off 0.5%, Voided 0.5% | ~75% |
| Collection receipt | Cleared 80%, Deposited 10%, Remitted 6%, Bounced 2%, Voided 2% | ~90% |
| Store visit | Completed 88%, Not visited/Abandoned 7%, Planned (future) 5% | ~90% |
| Route tour | Settled 90%, Variance under review 5%, Checked in 5% | 100% |
| Purchase order | Closed 70%, Received 8%, Partially received 7%, Sent 6%, Pending approval 4%, Rejected/Cancelled 5% | ~95% |
| Stock lot | Depleted 45%, Available 38%, Pick first 10%, Quarantine/Blocked 5%, Returned 2% | ~60% |
| Return (BO) | Credited/Replaced 65%, Inspected 10%, Received/Picked up 10%, Requested/Authorized 8%, Rejected 7% | ~90% |
| Principal claim | Settled 45%, Under principal review 20%, Submitted 12%, Approved/Partial 10%, Rejected 8%, Draft 5% | ~95%; the slow cycle is realistic [15] |
| Trade promotion | Ended/Claimed 55%, Active 30%, Approved/pending 10%, Cancelled 5% | ~85% |
| Master data | Outlet: Active 85%, On credit hold 4%, Blocked 2%, Inactive/Closed 6%, Prospect 3%. Product: Active 90%, Phase-out/Delisted 8%, New 2% | ~15% |

## 9. Natural content vocabulary (formats are judgment; all names are invented)

**Reference numbers:**
- SO-2607-004512 (sales order)
- SI-VS03-0719-0023 (van invoice for VS03 on 19 July)
- SI-2607-018844 (sales invoice)
- CR-2607-00931 (collection receipt)
- TOUR-VS03-20260719 (van tour)
- TRIP-T07-20260720 (delivery trip)
- PO-KST-2607-012 (purchase order to principal "KST")
- GRN-2607-0088 (goods receipt)
- LOT K26A0412 (stock lot)
- ADJ-2607-014 (stock adjustment)
- SC-A-2607-W2 (cycle count, A items, week 2)
- BO-2607-0231 (return / bad order)
- CLM-LMN-Q3-SCH-004 (principal claim)
- SCH-KST-2607-12P1 (trade promotion scheme)
- DA-2607-0045 (display agreement)
- Outlets: OUT-N2-01873, "Aling Nena Store (Brgy. San Roque)". Beats: PS04-TUE, VS02-THU.

**Principals:** Kestrel Dairy Corp.; Lumen Home Care Inc.; Palmera Personal Care; Tala Snack Foods; Brightbay Beverages; Sabaw Foods Mfg.; Northfield Canned Goods; Verdant Health OTC.

**SKUs (description format: brand, variant, pack × case count):**
- Kestrel Evaporated Filled Milk 370ml x48
- Kestrel Choco Milk Drink 180ml x24
- Sabaw Instant Noodles Beef 55g x72
- Sabaw Pancit Canton Kalamansi 60g x72
- Tala Corned Meat 150g x48
- Northfield Sardines in Tomato Sauce 155g x100
- Brightbay Cola 1.5L x12
- Brightbay Orange Juice Drink 250ml x24
- Aquapura Drinking Water 500ml x24
- Palmera Shampoo Sachet 12ml (12s) x24
- Palmera Bath Soap 90g x72
- Lumen Dishwashing Liquid Calamansi 250ml x24
- Lumen Powder Detergent 66g sachet x144
- Krunchi Cheese Rings 60g x50
- Verdant Paracetamol 500mg (10s) x50

Check trademarks before use; I did not search them.

**Return (BO) reason codes:**
- Expired
- Near expiry (≤30 days)
- Damaged in transit
- Crushed/dented can
- Swollen/bloated can
- Leaking
- Torn sachet/strip
- Rodent/pest damage
- Wrong item delivered
- Over-delivered
- Short-dated on delivery
- Price dispute
- Principal recall
- Packaging defect
- Slow-moving (policy exception)

**No-order and no-visit reasons** (the SAP help gives "customer closed" and "ran out of time" as examples [4]):
- Store closed
- Owner not around
- Stock still sufficient
- No cash today
- Account on credit hold
- Bought from wholesaler/market
- Requested item out of stock
- Ran out of time
- Road flooded/closed
- Outlet relocated

**Stock adjustment reasons:**
- Cycle count variance
- Expired – write-off
- Damaged in warehouse
- Pilferage/shortage
- Found stock
- Repack/re-case
- Sample/free goods issue
- Wrong lot posted
- Transfer error

**Claim rejection reasons:**
- Filed past claim deadline
- Missing proof of performance
- Secondary sales not in DMS
- SKU not covered by scheme
- Exceeds scheme cap
- Duplicate claim
- Unsigned outlet acknowledgment
- Display photos missing/unclear
- Price difference not pre-approved

**Credit decline and hold reasons:**
- Over limit
- 60+ days overdue
- Bounced cheque history
- New account, no trade references
- Business permit expired

**Note phrasing** (short, in abbreviated field shorthand):
- "Owner asked 12+1 on noodles, applied."
- "BO pickup 3 cs Kestrel evap, dented, see photo."
- "Cust promised to pay Fri, PDC dated 7/31."
- "Short 2 cs Brightbay 1.5L on GRN, principal DR says 50, counted 48."
- "Lot K26A0412 near expiry, push via van routes."
- "Cash short ₱1,250, salesman to explain at huddle."
- "Store closed, will revisit Thu."
- "Recount done, variance confirmed, raise ADJ."
- "Claim returned by principal — need signed outlet list."
- "Chiller display not maintained, audit failed, fee withheld."

## 10. Board content over a quarter (judgment)

- **All departments:**
  - Monthly: "Month-end cut-off: last day for invoices is the 30th."
  - Month-end closing: calendar event on days 1–3.
  - Quarterly: all-hands meeting on results.
- **Sales:**
  - Weekly Monday "sales huddle" event.
  - Announcements: new PJP from next month; beat changes for PS04/PS07; new scheme "Sabaw 12+1 until the 31st"; monthly target and top-performer post.
  - Events: route ride-along days and a mid-month performance review.
- **Key Accounts & Trade Marketing:**
  - Scheme launch posts, one or two per principal each month.
  - Supermarket listing or planogram reset event.
  - Display audit week.
  - Quarterly principal business review (QBR) event for each of the top 4 principals.
- **Purchasing:**
  - Principal price-increase notices ("Kestrel +3% effective 1st").
  - New-SKU listing and delisting notices.
  - Weekly PO cut-off per principal.
  - Principal plant shutdown or allocation notice.
- **Warehouse:**
  - Quarterly full stock take (a sales blackout day, with no dispatch).
  - Weekly cycle-count schedule.
  - Near-expiry list published every Monday.
  - Pest-control day and safety toolbox talk.
- **Logistics:**
  - Vehicle PMS schedule.
  - Registration renewals.
  - Holiday dispatch schedule.
  - Typhoon or flood suspension advisory (in the Philippines).
- **Credit & Collections:**
  - Statement run on day 1.
  - Weekly collection target.
  - Credit review committee (monthly).
  - Post-dated cheque deposit schedule.
- **Accounting & Claims:**
  - Claim filing deadlines per principal.
  - Principal reconciliation meeting.
  - Tax filing dates (for example, the monthly VAT return).
  - Year-end audit fieldwork.

## 11. Access, segregation of duties and refusals

**Groups** (OpenSlate levels are read, write and manage; guests are capped at read):

| Group | Access |
|---|---|
| Sales (pre-sellers, van sellers) | Write Store visit, Sales order and lines, Return, Route tour. Read Outlet, Product, Trade promotion, Sales invoice. No access to Accounting & Claims. |
| Sales supervisors | Manage Sales. Read Credit & Collections. |
| Trade Marketing / Key Accounts | Manage their department. Read Sales and Principal claim. |
| Purchasing | Write Purchase order, PO line, Product, Principal. Read Goods receipt and Stock lot. |
| Warehouse | Write Goods receipt, Stock lot, Stock count, Return, Return line. Read Product and Sales order. |
| Logistics | Write Delivery trip and Vehicle. Read Sales order. |
| Credit & Collections | Manage their department. Read Sales and Outlet. |
| Accounting & Claims | Manage their department. Write Stock adjustment approval (see below). Read everything. |
| Guests (principal account managers, external auditor) | Read Trade promotion and Product only. |

Principal guests do not get access to Principal claim. OpenSlate cannot limit them to their own principal's rows, so they would see every other principal's claims.

**Segregation-of-duties rules** [24][25][26]:
- The person who raises a PO does not approve it.
- The approver does not pay it.
- Receiving is not done by purchasing.
- AP three-way matches the PO, goods receipt and invoice.
- Cash custody (van seller, cashier) is separate from AR posting.
- The person who counts stock does not post the adjustment.

**Gap for the parent to decide:** OpenSlate cannot stop "the raiser approves their own PO" inside one module, because grants are per module. It needs one of two changes:
- Option A: move approval into a separate module that only Accounting can write, such as a "PO approval" or "Adjustment approval" record in Accounting & Claims.
- Option B: treat same-person approval as a logged policy exception, not a refusal.

The refusals below only use module-level denials.

**Planned refusals:**
1. A van salesman tries to change the Amount on a Sales invoice. He has read access to Credit & Collections, so the edit is refused. This is the classic cash-custody vs AR control.
2. A sales supervisor tries to set an invoice Status to Written off. Supervisors have read access to Credit & Collections, so this is refused.
3. A pre-seller tries to approve a Credit review for her own outlet. She has read access, so this is refused.
4. A warehouse picker tries to edit a Product's List price. Warehouse has read access to Purchasing, so this is refused.
5. A purchasing officer tries to edit a Principal invoice's Match result to clear a price variance. Purchasing has read access to Accounting, so this is refused (segregation of duties).
6. A principal account manager (guest) tries to change a Trade promotion's End date. Guests are capped at read, so this is refused.
7. A delivery driver tries to edit a Collection receipt amount. He has no access to Credit & Collections, so this is refused.
8. A trade marketing assistant tries to move a Principal claim to Settled. She has read access, so this is refused.

## 12. Cadences and seasonality

| Cadence | Activity |
|---|---|
| Daily | PJP visits; order cut-off (evening) and picking overnight; dispatch in the morning; van check-out and check-in; cash remittance and bank deposit; route settlement [4]; near-expiry check |
| Weekly | Replenishment POs per principal; A-item cycle counts; sales huddle; collection target review; PDC deposits |
| Monthly | Statements and aging review [23]; scheme close and claim compilation [15]; secondary-sales report to principals [16]; month-end close; credit committee; B-item counts |
| Quarterly | Full stock take; principal business reviews; PJP re-cut (PJPs are usually fixed for 3–6 months [9]); scheme budget resets |
| Yearly | Principal distribution agreement renewal and targets; year-end audit; C-item counts [27]; outlet census and re-classification |

**Seasonality (judgment, not sourced):**
- Philippines: Q4 "ber months" and the Christmas peak; the hot-dry season (March to May) is peak for beverages and ice; school opening lifts snacks and milk; the typhoon season (June to November) disrupts routes and raises damage BOs.
- India: Diwali. Kenya: Ramadan/Eid. UK: Christmas and summer.
- Everywhere: principal quarter-end pushes create month- and quarter-end order spikes, followed by higher returns.

---

## 13. Sources

1. https://solutions.ifrc.org/sites/default/files/2024-10/K014750_APQC%20Process%20Classification%20Framework%20(PCF)%20-%20Cross%20Industry%20-%20PDF%20Version%207.4.pdf — APQC PCF Cross-Industry v7.4 (Aug 2024), a mirror hosted by IFRC. I read the full text. It gives process IDs 3.3.4, 3.5.4, 3.5.6, 4.2.3, 4.4.2.4, 4.4.3, 6.2.4, 9.2.1–9.2.5 and 9.6.1.
2. https://www.apqc.org/resource-library/resource-listing/apqc-process-classification-framework-pcf-consumer-products-pdf-0 — An industry PCF for consumer products exists (v7.2.2). I did not read its contents.
3. https://www.ascm.org/corporate-solutions/standards-tools/scor-ds/ — SCOR processes Plan, Source, Make, Deliver, Return, Enable (from a search summary).
4. https://help.sap.com/doc/fb8c9956bd704afe9dd92a0bd96c1d42/2.0.0.0/en-US/sap_dsd_1.0_application_help_en.pdf — SAP Direct Store Delivery Application Help, v1.0, 2017-09-22. I read the full text. It covers start-of-day, check-out, tour processing, check-in, end-of-day, visit reason codes, van and pre-sell roles, and the settlement cockpit.
5. https://trailhead.salesforce.com/content/learn/modules/consumer-goods-cloud-data-model/set-up-store-visits-and-capture-data — Visit object fields and statuses (Planned, In Progress, Abandoned, Completed).
6. https://trailhead.salesforce.com/content/learn/modules/consumer-goods-cloud-data-model/understand-the-store-data-model — Retail Store fields: type, priority, payment method, delivery frequency, store group.
7. https://www.linkedin.com/pulse/serving-nanostores-van-sales-pre-sales-jan-fransoo — The Casablanca study: pre-sales gave higher volume and about 25% lower cost; outlet density decides the model.
8. https://www.synergiasoft.com/blog/van-sales-vs-presales-vs-dsd/ — Van vs pre-sell controls: day-close reconciliation, "book today, deliver tomorrow", proof of delivery, shortages.
9. https://spirestock.com/blog/what-is-beat-planning-fmcg — DMS vendor benchmarks: outlets per beat, calls per day, A/B/C frequency, productive-call rate, lines per call, PJP.
10. https://sfasoftware.com/fundamentals/what-is-strike-rate/ — Strike-rate benchmarks that corroborate [9] (from a search summary).
11. https://www.linkedin.com/pulse/some-fmcg-sales-terminologies-golam-mohiuddin — Calls per day of 40–45, "12+1" free goods, VPS, display rental (from a search summary).
12. https://beatroute.io/philippines/resources/blog/primary-order-in-retail-distribution-guide/ — Primary vs secondary orders in the Philippines, and the distributor's role.
13. https://beatroute.io/africa/fmcg/route-to-market/ — The African key-distributor, redistribution and duka structure.
14. https://nielseniq.com/global/en/insights/analysis/2014/sari-sari-stores-maximizing-distribution-opportunities/ — Sari-sari stores: 36% of FMCG sales, about 20 households, about 200 SKUs (2014 data).
15. https://www.fieldassist.com/blog/streamlined-distributor-claims-settlement-fieldassist-dms — Claim types (scheme, margin, return, custom) and the approval flow.
16. https://retailpos.co.in/distribution-management-system-fmcg-pharma-india-2026/ — Secondary sales as the basis for principal reports and claims, and scheme configuration (from a search summary).
17. https://www.cpgscout.ai/blog/what-is-trade-promotion — Off-invoice, bill-back, scan-back, lump-sum and deduction definitions (from a search summary).
18. https://help.sap.com/doc/d5bb63caf7904456bd85c9ec03d702e2/2020v2/en-US/app_help_chargebacks_2020v2.pdf — A chargeback defined as the distributor's price-difference claim. The document is written by Vistex and hosted on SAP Help (from a search summary).
19. https://www.extensiv.com/blog/what-is-fefo-first-expired-first-out — FEFO definition and lot/expiry capture at receipt.
20. https://www.researchgate.net/publication/329256674_Drivers_of_Product_Expiration_in_Consumer_Packaged_Goods_Retailing — The MLOR rule of about two-thirds of shelf life (from a search summary).
21. https://www.gs1.org/standards/id-keys/gtin — GTIN-13 for the each and GTIN-14 for the case (from a search summary).
22. https://www.gs1.org/standards/gs1-logistic-label-guideline/1-3 — The 18-digit SSCC on logistic units (from a search summary).
23. https://www.netsuite.com/portal/resource/articles/accounting/accounts-receivable-aging.shtml — AR aging buckets.
24. https://blink.ucsd.edu/finance/accountability/controls/practices/accounts-payable.html — AP segregation of duties.
25. https://financeandbusiness.ucdavis.edu/finance/controls-accountability/int-controls/practices/purchasing — Purchasing segregation of duties and the three-way match.
26. https://uoe-finance.ed.ac.uk/for-staff/financial-regulations-policies-and-procedures/financial-regulations-overview-page/segregation-of-duties — Requisitioner ≠ approver ≠ payer.
27. https://www.kardex.com/en-us/blog/cycle-counting-and-stock-audits — ABC cycle-count frequencies (from a search summary).
28. https://blog.massistcrm.com/cash-leakage-fmcg-van-sales-distribution — Van stock and cash reconciliation and variances (from a search summary).
29. https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/invoicing-requirements-under-the-eopt-act/ — Philippine RR 7-2024: the invoice replaces the official receipt.
30. https://cleartax.in/s/eway-bill-gst-rules-compliance — The Indian e-way bill threshold of ₹50,000.
31. https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/what-is-etims — Kenya eTIMS applies to all businesses.
32. https://committees.parliament.uk/writtenevidence/129651/html/ — Federation of Wholesale Distributors (FWD) evidence on the scale of UK wholesale.
33. https://en.wikipedia.org/wiki/Eby-Brown — Scale of a US convenience distributor (13,500 locations).
34. https://pinoynegosyo.net/expired-sari-sari-store-goods-3786.html — Philippine bad-order return practice. This is a weak source.
35. https://www.botree.ai/blog/essential-trade-promotions-for-fmcg-brands — QPS, VPS and free-goods scheme types (from a search summary).
