# Research brief: simulated private K-12 school for OpenSlate

**Answer.** Model an 834-student K–12 day school with 110 staff, 8 departments and 28 modules. The simulated span is one grading period: 2 weeks before classes start, about 10 teaching weeks (48 class days) and 1 report-card week. This gives **6,436 records**. Two design choices keep the record count inside the budget, and both match how real schools record data:

1. **Attendance is stored as exceptions.** Only absence episodes and late arrivals become records. This is "negative attendance": the teacher marks only the students who are absent. Ed-Fi names it as a recognized practice [3]. DepEd SF2 works the same way, where a blank cell means present [9]. Caveat: Ed-Fi recommends that a SIS store both present and absent events [3]. The simulation should present OpenSlate as the school's operations workspace, not as the official attendance record.
2. **Per-student gradebook scores are not stored.** OneRoster separates LineItems (assessments) from Results (one score per student per item) [2]. For this school, Results would be about 37,000 rows per grading period (10 graded items per section). The design stores these instead: Assessments (the LineItems), grade posting per section, report-card batches, and exceptions (Academic Alerts, Grade Change Requests). Real schools already handle report cards by exception, through deficiency notices and grade-change forms.

All names are invented. Anything without a citation is my own judgment from practice.

---

## 1. Reference organization profile

| Division | Grades | Sections | Avg size | Students |
|---|---|---|---|---|
| Lower School | K–5 | 18 homerooms (3/grade) | 20 | 360 |
| Middle School | 6–8 | 9 advisories; 63 course sections | 22 | 198 |
| Upper School | 9–12 | 12 advisories; 97 course sections | 23 | 276 |
| **Total** | | 39 homerooms; 178 class sections | | **834** |

**Staff (110):** 72 teachers (11.6 students per teacher), 6 teaching assistants and 32 non-teaching staff:
- Leadership: head of school, 3 principals, dean.
- Registrar and 2 clerks; 2 admissions staff.
- 3 counselors and 2 nurses.
- Bursar and 3 finance staff.
- Facilities manager and 5 maintenance leads.
- Librarian and assistant, activities coordinator.
- HR officer and 3 IT staff.

Benchmarks differ by region. In the US, NAIS member schools have a median enrollment of 364, a median of 8.2 students per teacher, and median class sizes of 14–16. Teachers there are 43.2% of total staff [16]. Private schools in the Philippines and the UK have larger sections and fewer support staff. The profile above sits between the two (judgment).

**Subjects:** English, Mathematics, Science (integrated in K–8; Biology, Chemistry and Physics in 9–12), Social Studies/History, a world language, Religion or Values Education, PE and Health, Visual Arts, Music, Computer Science, and 2–4 Upper School electives.

**Daily operation.**
- Gates open at 07:00. Homeroom registration runs 07:30–07:45. In England, schools must take a morning and an afternoon register and close each within 30 minutes [6].
- After registration, the attendance clerk calls the parents of students absent without a reason.
- Middle and Upper School rotate through 7–8 periods on a day cycle. Lower School students stay in their homerooms and see specialist teachers there.
- The clinic sees 5–7 students a day, and most go back to class (judgment; the outcome categories come from [26]).
- The cashier window is open during office hours. Dismissal is at about 15:00, and clubs and teams run until 17:00.

**Regional differences.**
- **Terms:**
  - US: August or September to May or June, in semesters or quarters.
  - England: 3 terms from September to July, with half-term breaks.
  - Philippines: 4 quarters from June to April [10]. DepEd moves public schools to 3 terms for SY 2026–27 (8 June 2026 to 8 April 2027, 201 class days) [13]. Private schools may keep quarters.
- **Grading:**
  - US: A–F letter grades and GPA.
  - England: GCSE grades 9–1 plus the school's own internal grades.
  - DepEd weights three components by subject: Written Work, Performance Tasks and the Quarterly Assessment. Math and Science use 40/40/20, and Languages use 30/50/20. Descriptors run from Outstanding (90–100) to Did Not Meet Expectations (below 75), and 75 is the pass mark [10][11]. DepEd may revise DO 8 for the 3-term calendar (not verified).
- **Fees:**
  - UK: fees are billed each term in advance. Families pay a deposit when they accept a place, and sibling discounts of 5–10% are common [19].
  - US: families sign an enrollment contract and pay a deposit. They choose a 1-, 2- or 10-payment plan and can add tuition insurance [17][18].
  - Philippines: families pay annually, per semester, quarterly or monthly. A student who withdraws in week 1 owes 10% of the term's fees, in week 2 owes 20%, and after that owes all fees [14]. Since 2024, the tax authority (BIR) requires invoices instead of official receipts [15].

## 2. Departments

| Department | Purpose | Lead | Staff |
|---|---|---|---|
| Registrar & Admissions | Inquiries, applications, student register, attendance records, transcripts | Registrar; Director of Admissions | Registrar clerks, admissions officer, attendance clerk |
| Academics | Courses, sections, timetable, assessments, report cards | Academic Dean / Division Principals | Department heads, teachers, advisers |
| Student Affairs | Behavior, counseling, parent contact | Dean of Students | Discipline officer, guidance counselors |
| Health Services | Clinic visits, health alerts, medication | School Nurse (RN) | Clinic nurse |
| Finance (Bursar) | Fee assessment, collection, discounts, financial aid | Bursar / Business Manager | Accounts receivable (AR) clerk, cashier, accounts payable |
| Facilities & Operations | Rooms, maintenance, bookings, purchasing | Facilities Manager | Maintenance lead, custodial supervisor, purchasing officer |
| Library & Activities | Library exceptions, clubs and teams | Head Librarian; Activities Coordinator | Library assistant, coaches and moderators (who are teachers) |
| Human Resources | Leave and cover | HR Officer | HR assistant; the principals' secretary arranges cover |

## 3. Core processes (who does each step, and the record it produces)

**Inquiry to enrollment**
1. The admissions officer logs an Inquiry.
2. The family tours the school, and the officer sets the Inquiry to Toured.
3. The family submits an Application. Admissions tracks the documents: report card, recommendation, birth certificate, and SF10/Form 137 in the Philippines [30].
4. Admissions records the entrance test and the interview on the Application.
5. The committee records a decision: Accepted, Waitlisted or Declined.
6. The family signs the contract and pays the deposit. Veracross tracks this stage as "Accepted: Enrollment Not Started", then "Enrollment In Process", then "Newly Enrolled" [20].
7. The registrar creates the Student record and assigns a homeroom.

The NAIS medians give the funnel: 46.6% of inquiries become completed applications, 66% of those are accepted, and 71.4% of accepted students enroll [16].

**Enrollment to billing to collection**
1. The Student record reaches Enrolled.
2. The AR clerk creates the Fee Assessment from the Fee Items and the family's payment plan.
3. The bursar approves Fee Adjustments: sibling discount, scholarship or staff tuition remission.
4. The cashier records each Payment with its invoice or receipt number.
5. The AR clerk sets overdue accounts to Past due and opens a Collection Case.
6. The case moves through reminder, promissory note, exam-permit or clearance hold, and settlement.

The IRMS retention schedule keeps debt records for 6 years after the final payment [22].

**Assessment to report card**
1. The teacher creates the Assessments for each section, using the OneRoster LineItem categories [2].
2. At midterm, the teacher raises Academic Alerts for students at risk.
3. The teacher posts grades. The Class Section grade status moves from Open to Submitted.
4. The division principal approves the grades.
5. The registrar runs a Report Card Batch for each homeroom. The batch moves to Released and then to conference follow-up.

A late correction goes through a Grade Change Request, which the principal approves.

**Incident to resolution**
1. A teacher or duty staff member logs a Behavior Incident with its behavior, level, location and students. One incident can include many students, each with a role [4][5].
2. The dean investigates.
3. The dean records an action: warning, detention or suspension. England counts suspension length in half-day sessions [8].
4. Staff log the parent contact in the Parent Contact Log.
5. If needed, the dean opens a Guidance Case. The incident then moves to Closed.

**Request to repair**
1. Any staff member logs a Maintenance Request against a Room.
2. The facilities manager sets the priority and assigns the work.
3. The request moves to In progress. If parts are needed, it goes On hold with a Purchase Request.
4. The request moves to Completed, then Closed. Brightly (now Siemens) marks work orders completed and then archives them as read-only [29].

## 4. Modules (28)

**How to read the module lines:** each field is `Field:Type`. An asterisk (*) means required. Status stages are listed in order with →. Exception states follow the ∣ sign.

**Registrar & Admissions**
1. **Admission Inquiry**: Inquiry no:Text*, Child name:Text*, Entry grade:Select*(K–12), Entry year:Select*, Parent email:Email*, Source:Select(Website, Referral, Open house, Walk-in, Sibling, Fair), Inquiry date:Date*, Owner:User, Notes:Long text; Status:Select*[New → Contacted → Toured → Applied ∣ Not interested, No response].
2. **Application**: Application no:Text*, Applicant name:Text*, Entry grade:Select*, Submitted:Date*, Test date:Date, Test score:Number, Interview date:Date/Time, Documents complete:Checkbox, Decision:Select(Accepted, Waitlisted, Declined, Deferred), Reader:User; Status:Select*[Started → Submitted → Complete → Testing & interview → Decision released → Enrollment in process → Enrolled ∣ Withdrawn, Declined offer].
3. **Student**: Student no:Text*, LRN/UPN/State ID:Text, Last name:Text*, First name:Text*, Birth date:Date*, Grade level:Select*, Division:Select*(Lower, Middle, Upper), Homeroom:Text, Primary guardian:Text*, Guardian email:Email*, Guardian mobile:Text*, Health alert on file:Checkbox, Adviser:User; Status:Select*[Incoming → Enrolled ∣ On leave, Withdrawn, Transferred out, Graduated].
4. **Enrollment Change**: Change type:Select*(Section transfer, Withdrawal, Leave of absence, Re-admission, Grade-level change), Effective date:Date*, Reason:Long text*, Clearance done:Checkbox, Requested by:User*; Status:Select*[Requested → Principal approved → Registrar processed ∣ Rejected, Cancelled].
5. **Attendance Exception**: Date:Date*, Code:Select*(Absent–Illness, Absent–Medical appointment, Absent–Family/exceptional, Absent–Religious observance, Absent–Unauthorized, Absent–Unexplained, Late before register close, Late after close, Left early, Suspended, School activity/trip; the DfE and SF2 equivalents are in §9), Days in episode:Integer, Consecutive days absent:Integer, Arrival time:Date/Time, Reason notes:Text, Reported by:Select(Parent call, Parent note, Teacher, Clinic, Nobody), Recorded by:User*; Status:Select*[Unexplained → Explained → Verified ∣ Amended]. In England, a changed entry must keep the original entry, the new entry, the reason, the date and the person who changed it [6].

**Academics**
6. **Course**: Course code:Text*, Title:Text*, Subject area:Select*, Grade levels:Text, Credits:Number, Weighting scheme:Select(WW30/PT50/QA20, WW40/PT40/QA20, WW20/PT60/QA20, Standard), Department head:User; Status:Select*[Proposed → Active ∣ Retired].
7. **Class Section**: Section code:Text*, Period/Block:Select, Term:Select*, Teacher:User*, Co-teacher:User, Capacity:Integer, Enrolled count:Integer, Grade status:Select*[Open → Submitted → Approved → Posted ∣ Returned for correction].
8. **Assessment** (OneRoster LineItem): Title:Text*, Category:Select*(Written work, Performance task, Quarterly/term exam, Quiz, Project, Lab), Assign date:Date, Due date:Date*, Max score:Number*, Weight %:Number, Grading period:Select*; Status:Select*[Planned → Assigned → Collected → Marked → Returned ∣ Cancelled, Rescheduled].
9. **Report Card Batch**: Homeroom:Text*, Grading period:Select*, Sections approved:Integer, Adviser:User*, Release date:Date; Status:Select*[Collecting grades → Adviser review → Principal sign-off → Released → Conference follow-up ∣ Held (finance clearance)].
10. **Academic Alert**: Alert type:Select*(Failing at midterm, Missing work, Incomplete, Sudden drop, Excessive absence), Current mark:Number, Teacher:User*, Parent informed:Checkbox, Plan:Long text; Status:Select*[Raised → Parent notified → Intervention → Resolved ∣ Escalated to guidance].
11. **Grade Change Request**: Original grade:Number*, New grade:Number*, Reason:Select*(Calculation error, Late work accepted, Incomplete resolved, Re-assessment), Justification:Long text*, Requested by:User*, Approver:User; Status:Select*[Submitted → Principal approved → Registrar posted ∣ Rejected].

**Student Affairs**
12. **Behavior Incident**: Incident no:Text*, Date/time:Date/Time*, Location:Select*(Classroom, Corridor, Canteen, Field, Restroom, Bus, Online, Off-site trip), Behavior:Select*(see §9), Level:Select*(Level 1 minor, Level 2 moderate, Level 3 major), Description:Long text*, Reported by:User*, Action:Select(Verbal warning, Detention, Behavior contract, Parent conference, Internal suspension, Suspension, Referral to counselor), Suspension sessions:Integer; Status:Select*[Reported → Under investigation → Action assigned → Parent informed → Closed ∣ Appealed, Unfounded].
13. **Guidance Case**: Referral source:Select*(Teacher, Parent, Self, Dean, Nurse, Attendance), Concern:Select*(Academic, Attendance, Peer relations, Family, Emotional wellbeing, Career/college), Counselor:User*, Opened:Date*, Sessions held:Integer, Confidential notes:Long text; Status:Select*[Referred → Intake → Active → Monitoring → Closed ∣ Referred externally].
14. **Parent Contact Log**: Contact type:Select*(Absence call, Academic, Behavior, Health, Finance, Conference, General), Channel:Select*(Phone, Email, In person, Portal message), Contact date:Date/Time*, Summary:Long text*, Staff:User*, Follow-up needed:Checkbox; Status:Select*[To contact → Contacted → Follow-up due → Done ∣ Unreachable].

**Health Services**
15. **Clinic Visit**: Time in:Date/Time*, Complaint:Select*(see §9), Assessment notes:Long text, Temp °C:Number, Intervention:Select(Rest, First aid, Ice pack, Medication given, Parent called, Observation), Medication given:Text, Disposition:Select*(Returned to class, Sent home, Referred to doctor, Ambulance/EMS [26]), Injury on premises:Checkbox, Hazard involved:Checkbox, Nurse:User*; Status:Select*[Open → Disposed → Parent informed → Closed].
16. **Health Alert**: Condition:Select*(Food allergy – anaphylaxis, Asthma, Type 1 diabetes, Seizure disorder, Cardiac, ADHD medication, Other), Severity:Select*(Life-threatening, Moderate, Monitor), Staff-facing instruction:Text*, Care plan on file:Checkbox, Review date:Date; Status:Select*[Pending documents → Active ∣ Expired, Archived].

**Finance**
17. **Fee Item**: Code:Text*, Name:Text*, Category:Select*(Tuition, Miscellaneous, Other school fees, Deposits, Activity, Transport), Amount:Number*, Applies to:Select*(All, Lower, Middle, Upper, Optional), Refundable:Checkbox; Status:Select*[Draft → Board approved ∣ Discontinued].
18. **Fee Assessment**: SOA no:Text*, School year:Select*, Payment plan:Select*(Annual, Semestral, Quarterly, Monthly/10-pay), Gross fees:Number*, Adjustments total:Number, Net due:Number*, Balance:Number*, Next due date:Date, AR clerk:User; Status:Select*[Draft → Issued → Partially paid → Paid ∣ Past due, Under payment arrangement, Written off, Refunded]. Gibbon uses Pending, Issued, Paid and "Paid - Partial" [21].
19. **Payment**: Receipt/Invoice no:Text*, Date:Date*, Amount:Number*, Method:Select*(Cash, Check, Bank transfer, Card, E-wallet, Payment center), Reference:Text, Installment:Select(Down payment, 1st–10th, Full), Cashier:User*; Status:Select*[Recorded → Deposited → Reconciled ∣ Bounced, Voided].
20. **Fee Adjustment**: Type:Select*(Sibling discount, Academic scholarship, Need-based aid, Staff tuition remission, Early payment discount, Athletic grant), Basis:Select(% of tuition, Fixed amount), Value:Number*, Amount:Number*, Committee ref:Text, Approved by:User; Status:Select*[Requested → Under review → Approved → Applied ∣ Declined, Revoked].
21. **Collection Case**: Amount overdue:Number*, Days overdue band:Select*(1–30, 31–60, 61–90, 90+), Stage:Select*(Reminder 1, Reminder 2, Promissory note, Exam permit hold, Clearance hold, Referred), Promised date:Date, Owner:User*; Status:Select*[Open → Promise to pay → Settled ∣ Broken promise, Withdrawn student, Written off].

**Facilities & Operations**
22. **Room**: Room code:Text*, Building:Select*, Type:Select*(Classroom, Science lab, Computer lab, Gym, Auditorium, Library, Music room, Clinic, Office), Capacity:Integer, Custodian:User; Status:Select*[Available ∣ Under repair, Closed].
23. **Maintenance Request**: WO no:Text*, Category:Select*(Electrical, Plumbing, Aircon/HVAC, Carpentry, IT/AV, Custodial, Safety hazard, Grounds, Preventive), Priority:Select*(Emergency, High, Normal, Low), Description:Long text*, Requested by:User*, Assigned to:User, Completed on:Date; Status:Select*[New → Assigned → In progress → Completed → Closed ∣ On hold (parts), Rejected, Duplicate].
24. **Room Booking**: Event:Text*, Venue:Select*(Classroom, Lab, Gym, Auditorium, Field, Library), Start:Date/Time*, End:Date/Time*, Setup needs:Long text, Attendance:Integer, Requested by:User*; Status:Select*[Requested → Confirmed → Completed ∣ Pending approval, Declined, Cancelled].
25. **Purchase Request**: PR no:Text*, Item/description:Long text*, Qty:Integer*, Est. amount:Number*, Budget line:Select*, Requested by:User*, Approver:User; Status:Select*[Draft → Submitted → Approved → Ordered → Received ∣ Rejected, Cancelled].

**Library & Activities**
26. **Library Case**: Barcode:Text*, Title:Text*, Case type:Select*(Overdue, Lost, Damaged, Fine), Due date:Date, Fine amount:Number, Librarian:User; Status:Select*[Open → Notice sent → Returned/Paid → Closed ∣ Waived, Charged to account]. Koha, a library system, treats Lost and Damaged as item states [28].
27. **Activity**: Name:Text*, Type:Select*(Club, Varsity team, Performing group, Service, Academic competition), Moderator:User*, Meeting day:Select, Room:Text, Max members:Integer, Members:Integer; Status:Select*[Proposed → Approved → Active ∣ Suspended, Dissolved].

**Human Resources**
28. **Staff Leave**: Employee:User*, Leave type:Select*(Sick, Vacation, Personal, Bereavement, Professional development, Maternity/Paternity), From:Date*, To:Date*, Days:Number*, Cover needed:Checkbox, Cover teacher:User, Cover status:Select(Not needed, Needed, Arranged); Status:Select*[Filed → Supervisor approved → HR recorded ∣ Declined, Cancelled].

## 5. Relationships

| Link | Cardinality | Reason |
|---|---|---|
| Admission Inquiry → Application | 1:N | One family inquiry can lead to applications for several siblings. |
| Application → Student | 1:1 | The accepted applicant becomes the register entry. |
| Student ↔ Class Section | M:N | The class roster (OneRoster Enrollment [1]). |
| Course → Class Section | 1:N | One course runs as several sections. |
| Room → Class Section | 1:N | The room where the section is timetabled. |
| Class Section → Assessment | 1:N | LineItems belong to a class [2]. |
| Class Section → Report Card Batch | 1:N | One batch per homeroom per grading period. |
| Student → Attendance Exception | 1:N | The student's absences. |
| Student / Class Section → Academic Alert | 1:N each | One student in one subject. |
| Student / Class Section → Grade Change Request | 1:N each | One student in one subject. |
| Student → Enrollment Change | 1:N | Transfers and withdrawals. |
| Student ↔ Behavior Incident | M:N | Several students can be in one incident [4][5]. |
| Behavior Incident → Guidance Case | 1:N | Referral out of discipline. |
| Student → Guidance Case, Clinic Visit, Health Alert, Parent Contact Log, Library Case | 1:N | The student's history. |
| Clinic Visit → Attendance Exception | 1:1 | Sent home = partial-day absence. |
| Student → Fee Assessment | 1:N | One per school year. |
| Fee Item ↔ Fee Assessment | M:N | The fee lines on the account. |
| Fee Assessment → Payment, Fee Adjustment, Collection Case | 1:N | Accounts receivable detail. |
| Room → Maintenance Request, Room Booking | 1:N | Where the work or event happens. |
| Maintenance Request → Purchase Request | 1:N | Parts for a repair. |
| Student ↔ Activity | M:N | Club and team membership. |

**Assumption: relationship links are not records.** If links count toward the budget, the roster alone is about 5,800 links and the fee lines are about 5,000. Together they exceed the budget, and the scope must change.

**Family module:** leaving it out means no sibling links and no per-family billing, which is normal in the US and UK. Adding it (about 620 records at 1.35 children per family, judgment) brings the total to about 7,050.

## 6. Automations

Assumptions behind these rules:
- Each rule has one action.
- A record that a rule creates gets only fixed values. Staff set its links (student, section) and any values copied from other records.
- The engine cannot do date math, compare two fields, add up values or send notifications. Rules 3 and 4 depend on fields that staff keep up to date.
- To "notify" someone, a rule creates a Parent Contact Log with Status = To contact.

1. **Application.Status changes to Enrolled** ⇒ create a Student (Status = Incoming).
2. **Student.Status changes to Enrolled** ⇒ create a Fee Assessment (Status = Draft).
3. **Attendance Exception is created with Code = Absent–Unexplained** ⇒ create a Parent Contact Log (Type = Absence call). DfE guidance says code N must not be left on the record [6].
4. **Attendance Exception.Consecutive days absent crosses 5** ⇒ create a Guidance Case (Source = Attendance). SF2 calls for adviser intervention after 5 consecutive absences [9].
5. **Clinic Visit is created with Disposition = Sent home** ⇒ create an Attendance Exception (Code = Left early, Status = Explained).
6. **Clinic Visit is created with Injury on premises = true** ⇒ create a Parent Contact Log (Type = Health).
7. **Clinic Visit is created with Hazard involved = true** ⇒ create a Maintenance Request (Category = Safety hazard, Priority = High).
8. **Behavior Incident.Level changes to Level 3 major** ⇒ create a Parent Contact Log (Type = Behavior).
9. **Academic Alert is created** ⇒ create a Parent Contact Log (Type = Academic).
10. **Fee Assessment.Status changes to Past due** ⇒ create a Collection Case (Stage = Reminder 1).
11. **Room Booking is created with Venue = Auditorium** ⇒ set Status = Pending approval.
12. **Every Monday at 06:30** ⇒ create a Maintenance Request (Category = Preventive, Description = "Weekly fire extinguisher, emergency light and exit check").

Optional extras: when a Payment is set to Bounced, create a Collection Case. When Staff Leave reaches Supervisor approved and Cover needed = true, set Cover status = Needed.

## 7. Volumes (computed with a script)

**Inputs:**
- 834 students and 48 class days.
- Full-day absence rate of 3.0%, with 1.7 days per episode. That gives 1,201 absence-days in 706 episodes.
- Late rate of 0.8% of student-days, which gives 320 late arrivals.
- For comparison, English state schools average 6.78% absence (primary 5.20%, secondary 8.44%), and illness is the main cause [7]. Independent schools are lower (judgment).
- Payment plans: Annual 30%, Semestral 25%, Quarterly 25%, Monthly 20%. Monthly payers make 3 payments in the window. With 88% paying on time, that gives 1,027 payments.

| Module | Count | Module | Count |
|---|---|---|---|
| Admission Inquiry | 220 | Guidance Case | 65 |
| Application | 80 | Parent Contact Log | 240 |
| Student | 834 | Clinic Visit | 290 |
| Enrollment Change | 28 | Health Alert | 100 |
| Attendance Exception | 1,026 | Fee Item | 26 |
| Course | 50 | Fee Assessment | 834 |
| Class Section | 178 | Payment | 1,027 |
| Assessment | 356 (2 major per section) | Fee Adjustment | 140 |
| Report Card Batch | 39 | Collection Case | 70 |
| Academic Alert | 150 | Room | 70 |
| Grade Change Request | 18 | Maintenance Request | 130 |
| Behavior Incident | 90 | Room Booking | 95 |
| Library Case | 80 | Purchase Request | 50 |
| Activity | 40 | Staff Leave | 110 |
| **Total** | | | **6,436** |

The total is 7% over "about 6,000" but inside the 5,000–7,000 range. To reduce it:
- Lower the on-time payment share from 0.88 to 0.80 (−93 records).
- Lower clinic visits from 290 to 240 (−50).
- Use 1.5 Assessments per section instead of 2 (−89).

**Why the ratios look like this:**
- **Registrar and Finance** hold 67% of all records, which is where most of the clerical work is.
- **Inquiries:** 220 is about 26% of a full year's cycle, scaled from the NAIS medians (385 inquiries for a 364-student school [16]). Early fall is the start of the admissions season.
- **Fee Adjustments:** 140 covers 17% of students. That is below the NAIS medians of 26.2% on financial aid plus 4.3% on staff tuition remission [16], because the profile mixes regions (judgment).
- **Clinic:** 290 visits is about 6 a day (judgment).
- **Behavior Incidents:** 90 is about 1 per 9 students. Only Level 2 and above are logged here (judgment).

## 8. Status distribution at the end of the simulation (report-card week)

| Module | Distribution (%) | Share that changed status |
|---|---|---|
| Admission Inquiry | New 20, Contacted 35, Toured 25, Applied 10, Not interested/No response 10 | 70% |
| Application | Started 25, Submitted 30, Complete 20, Testing 15, Decision released 7, Withdrawn 3 | 55% (next year's cycle, still early) |
| Student | Enrolled 97.5, Incoming 0.5, Withdrawn/Transferred 1.5, On leave 0.5 | 3% |
| Attendance Exception | Verified 80, Explained 12, Unexplained 5, Amended 3 | 85% |
| Class Section (grade status) | Posted 85, Approved 8, Submitted 4, Returned 3 | 100% |
| Report Card Batch | Released 72, Conference follow-up 15, Principal sign-off 8, Held 5 | 100% |
| Academic Alert | Resolved 45, Intervention 30, Parent notified 15, Escalated 10 | 90% |
| Behavior Incident | Closed 70, Parent informed 12, Action assigned 10, Under investigation 5, Appealed/Unfounded 3 | 95% |
| Clinic Visit | Closed 92, Parent informed 6, Disposed 2 | 98% (same day) |
| Fee Assessment | Paid 32, Partially paid 50, Issued 5, Past due 9, Payment arrangement 3, Refunded 1 | 95% |
| Payment | Reconciled 80, Deposited 15, Recorded 3, Bounced/Voided 2 | 97% |
| Fee Adjustment | Applied 80, Approved 5, Under review 8, Declined 5, Revoked 2 | 90% |
| Collection Case | Open 35, Promise to pay 30, Settled 25, Broken promise 8, Written off 2 | 65% |
| Maintenance Request | Closed 60, Completed 12, In progress 10, Assigned 8, On hold 5, New 3, Rejected/Duplicate 2 | 97% |
| Room Booking | Completed 55, Confirmed 30, Pending approval 5, Cancelled/Declined 10 | 70% |
| Purchase Request | Received 45, Ordered 20, Approved 15, Submitted 12, Rejected 8 | 90% |
| Staff Leave | HR recorded 85, Supervisor approved 8, Filed 4, Declined/Cancelled 3 | 96% |

Across all modules, 75% of records (4,830) change status at least once. Reference records (Student, Course, Room, Fee Item, Activity) mostly stay at their first working status.

## 9. Content vocabulary (invented)

**Identifiers**
- Student numbers: `2024-0417`, `2019-0038` (year of entry plus a sequence number).
- National IDs: the Philippine LRN has 12 digits, for example `136548190023` [12]. The English UPN is one letter plus 12 digits. US schools use a state ID.
- Homeroom names: Philippine schools name sections after flowers, trees, heroes or virtues, for example `K-Sampaguita`, `3-Narra`, `7-Rizal`, `10-Faith`. US and UK styles: `9 Adv-Moreno`, `10B`, `11/Ma2`.
- Course codes: `ENG7`, `MATH9`, `SCI10-CHEM`, `AP-BIO`, `FIL8`, `MAPEH6`, `CS11-ELEC`.
- Section codes: `MATH9-C (P3)`, `ENG11-A (Day 2 B4)`.
- Finance numbers: `SOA-2627-0417`; `SI 004821` (service invoice [15]); `OR 018233` (official receipt, before 2025); `RCPT-26-01122`.
- Other numbers: `WO-26-0142`, `PR-26-031`, `INC-26-0077`, `INQ-26-0219`, `APP-2728-045`.

**Absence and late codes**

DfE codes for schools in England [6]:

| Code | Meaning |
|---|---|
| / \ | Present (morning / afternoon) |
| L | Late, before the register closes |
| U | Late, after the register closes |
| I | Illness |
| M | Medical or dental appointment |
| C1 | Performance |
| R | Religious observance |
| J1 | Interview |
| E | Suspended |
| G | Holiday not authorized |
| N | Reason not yet known |
| O | Unexplained |
| V | Educational visit |
| P | Approved sport |
| B | Other off-site activity |
| Y2 | Travel disruption |

Philippine SF2 marks [9]: blank = present, x = absent, top half shaded = late, bottom half shaded = cutting class.

Typical reason notes: "fever, mom called 7:40"; "dental appt, back after lunch"; "family trip – not approved"; "flooding on route, bus late"; "death in family (grandmother)"; "LBM"; "tournament – varsity football"; "overslept, 3rd late this month".

**Incident behaviors** (based on the DfE suspension reason categories [8], in local wording)
- Persistent disruptive behavior
- Verbal abuse toward staff
- Physical assault on another pupil ("pushing at lunch line")
- Bullying or cyberbullying ("group chat exclusion and name-calling")
- Racist or disability-related abuse
- Damage to property ("wrote on CR wall")
- Theft ("took classmate's calculator")
- Vaping in the restroom
- Phone use during an exam
- Cheating or plagiarism
- Uniform or grooming violation
- Cutting class
- Repeated tardiness
- Leaving campus without permission

A search summary says DfE adds new reasons from August 2026 for vaping, mobile phones and harmful sexual behavior. The methodology page [8] does not confirm this.

**Clinic complaints**
- Headache
- Fever (37.8–38.5 °C)
- Stomachache
- LBM/diarrhea
- Vomiting
- Toothache
- Menstrual cramps
- Asthma attack
- Allergic rash
- Sprained ankle in PE
- Nosebleed
- Minor cut
- Dizziness after a skipped breakfast
- Eye irritation
- Sore throat

Note style: "C/O headache since 2nd period. T 37.2. Rested 20 min, RTC."

**Maintenance issues**
- Aircon not cooling, Rm 204
- Leaking faucet, 2F girls' CR
- Flickering lights, Chem Lab
- Projector shows no signal, Rm 110
- Broken chair armrests (x4)
- Clogged drain, canteen
- Door lock jammed, Faculty Room
- Ceiling stain in the library after rain
- Gym scoreboard dead
- Exposed wiring at the covered court (Emergency)
- Expired fire extinguisher
- Wi-Fi access point down, Middle School wing
- Loose stair nosing

**Fee items**
- Tuition
- Registration fee
- Miscellaneous fee
- Laboratory fee
- Learning materials
- Energy fee
- PTA dues
- Yearbook
- Graduation fee
- Field trip
- Retreat
- School bus
- Uniform and PE kit
- Acceptance deposit
- Re-enrollment deposit
- Late payment surcharge
- Transcript fee

**Staff note phrasing**
- "Parent informed via Viber, will send excuse letter tomorrow."
- "Promissory note signed; balance ₱18,450 due on or before Oct 15."
- "Exam permit on hold pending 2nd installment."
- "Returned for correction: QA scores not encoded for 3 students."

## 10. Board content over the grading period

| Department | Announcements | Calendar events |
|---|---|---|
| Registrar | New-student enrollment closes; class lists posted; submit SF10 or transcripts | Report card release (finance clearance required) |
| Academics | Grade submission checklist; rotating bell schedule | Midterm progress reports due; grade encoding deadline; term exams week |
| Student Affairs | Uniform policy reminder; counseling drop-in hours | Anti-bullying week; Grade 12 career talk |
| Health Services | Medication consent forms due; heat advisory; keep children home 24 hours after a fever | Physical and dental screening by grade |
| Finance | 2nd installment due on the 15th; exam permits on hold for past-due accounts | Scholarship renewal window |
| Facilities | Water interruption on Saturday; auditorium closed for repair | Fire and earthquake drill |
| Library & Activities | Club sign-ups; varsity schedule | Club fair; intramurals; book fair; Foundation Day |
| School-wide | Parents' Night invitation | First day of classes; parent-teacher conferences; holidays and half-term |

## 11. Access patterns and refusals

**Rules from privacy law:**
- FERPA lets a school share records with its own officials who have a legitimate educational interest. It advises sharing only the minimum personal data needed [23].
- School nurse records are FERPA education records, not HIPAA records [24][27].
- UK GDPR treats health data as special category data, which needs extra protection [25].

OpenSlate grants access per module, not per record. The groups are therefore:
- **Teachers:**
  - Read: Student, and Health Alert (allergy and asthma instructions only).
  - Write: Attendance Exception, Assessment, Academic Alert, Grade Change Request, Behavior Incident, Parent Contact Log.
  - No access: Clinic Visit, Guidance Case, Finance.

  Showing teachers only the short alert follows FERPA's minimum-data advice (judgment).
- **Counselors:** manage Guidance Case. The dean can read it.
- **Finance (separation of duties):** the cashier writes Payment and reads Fee Assessment. The AR clerk writes Fee Assessment and Collection Case. Only the bursar writes Fee Adjustment, and the bursar can only read Payment. The person who approves discounts never handles cash.
- **Guests:** an external auditor reads Finance, because guests are limited to read access. A visiting accreditor reads Course and Class Section.

**Refused actions** (each one is refused at the module level):
1. A teacher opens a Fee Assessment to check whether a student is cleared. The module is hidden (404).
2. A teacher opens a Clinic Visit. The module is hidden. The teacher can read only the Health Alert.
3. The cashier approves a Fee Adjustment. Refused: only the bursar writes Fee Adjustment.
4. The bursar records a walk-in Payment. Refused: the bursar can only read Payment.
5. The nurse opens a Behavior Incident. The module is hidden.
6. The facilities manager searches Student for a parent's phone number. The module is hidden.
7. The external auditor edits a Payment reference. Refused: guests can only read.
8. A counselor changes a Class Section grade status. Refused: counselors can only read Academics.

**Gap:** write access to a module lets a user make any status change in it. A teacher who can submit a Grade Change Request can also mark it "Principal approved", and staff who file leave can also approve it. Real schools control who can move a record to each status. The simulation should log these self-approvals as policy breaches, not as refusals. The other option is to put requests and approvals in separate modules.

## 12. Cadences and calendar shape

- **Daily:** morning register (and an afternoon register in England [6]), absence calls, clinic visits, cashier postings, bank deposit, incident logging.
- **Weekly:** attendance review, including the check for 5 consecutive absences [9]; department meetings; review of overdue accounts by age; preventive maintenance walk.
- **Monthly:** SF2 attendance summary goes to the principal [9]; monthly-plan installments fall due; purchasing cycle.
- **Each grading period (9–13 weeks):** assessments, midterm alerts, exams, grade posting, report cards, then parent-teacher conferences.
- **Annual:**
  - Admissions season: US September to March; Philippines January to May; UK the autumn before entry.
  - Re-enrollment and deposits.
  - The board sets the fees.
  - Financial aid committee.
  - Audit.
- **Retention (UK reference):** attendance registers 6 years [6]; secondary student file until date of birth + 25 years; finance records current year + 6 years [22].

A school year has about 180 class days (US, judgment) to 201 (DepEd SY 2026–27 [13]). It has 2–4 grading periods, exams at the end of each period, and 1–2 conference windows.

## 13. Sources

Sources marked **(summary)** were checked only through search-result summaries, not the full page.

1. https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-informationmodel/OneRosterv1p2RosteringService_InfoModelv1p0.html: OneRoster 1.2 Class, Course, AcademicSession and Enrollment.
2. https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/gradebook-informationmodel/OneRosterv1p2GradebookService_InfoModelv1p0.html: LineItem, Result, Category and scoreStatus.
3. https://docs.ed-fi.org/reference/data-exchange/data-standard/model-reference/student-attendance-domain/best-practices-and-use-cases/: negative and positive attendance; attendance event fields.
4. https://docs.ed-fi.org/reference/data-exchange/data-standard/model-reference/discipline-domain/overview/: discipline incidents, actions and student roles.
5. https://ed.sc.gov/districts-schools/school-safety/discipline-related-reports/incident-management-training/powerschool-incident-management-user-training/: PowerSchool incident participants **(summary)**.
6. https://assets.publishing.service.gov.uk/media/6a4f9ec6a6586e258d371bd0/Working_together_to_improve_school_attendance_2026.pdf: DfE July 2026 attendance guidance: codes, 30-minute register, 6-year retention.
7. https://explore-education-statistics.service.gov.uk/find-statistics/pupil-absence-in-schools-in-england/2024-25: 2024/25 absence rates (published 26 March 2026).
8. https://explore-education-statistics.service.gov.uk/methodology/pupil-exclusion-statistics-methodology: 16 suspension reason codes; suspension length in sessions.
9. https://catanduanes.deped.gov.ph/files/SF2-Daily-Attendance-Report-of-Learners.pdf: DepEd SF2 marks, dropout reasons, intervention after 5 consecutive absences.
10. https://www.deped.gov.ph/wp-content/uploads/2015/04/DO_s2015_08.pdf: DepEd DO 8 s.2015. This is a scanned PDF and its text was not verified. It was read through https://depedph.com/deped-order-8/: 4 quarters, raw score 60 = grade 75, values marks AO/SO/RO/NO.
11. https://www.teacherph.com/deped-grading-system/: DO 8 weights and descriptors **(summary; secondary)**.
12. https://www.teacherph.com/deped-learner-reference-number-lrn/: the 12-digit LRN **(summary; secondary)**.
13. https://mb.com.ph/2026/04/20/back-to-school-deped-sets-june-8-opening-of-classes-for-sy-20262027: DO 009 s.2026, three-term calendar **(summary; news)**.
14. https://www.respicio.ph/commentaries/are-withdrawal-fees-legal-philippine-rules-on-school-tuition-refunds-after-enrollment: Manual of Regulations for Private Schools §66 refund rule **(summary; secondary)**.
15. https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/invoicing-requirements-under-the-eopt-act/: RR 7-2024, invoices replace official receipts **(summary)**.
16. https://www.nais.org/getContentAsset/9bc8aaf6-eef1-4aa7-937e-80e64eff526e/dfc3d011-8f63-43f6-9ed8-4b444333a1d0/Facts-at-a-Glance-2024-2025-(NAIS-Members).pdf?language=en-US: NAIS 2024-25 admissions funnel, ratios, aid, class sizes.
17. https://www.nboa.org/net-assets/article/essential-elements-of-independent-school-agreement: NBOA on enrollment contracts (2018).
18. https://www.venable.com/insights/publications/2024/09/planning-for-the-2025-2026-enrollment-season: payment plans and TILA **(summary)**.
19. https://www.surbitonhigh.com/admissions/fees/: UK termly fees, deposit, sibling discount **(summary)**.
20. https://community.veracross.com/s/article/Enrollment-Status-Definitions: Veracross enrollment statuses **(summary; the page would not load)**.
21. https://github.com/GibbonEdu/core/blob/main/modules/Finance/invoices_view_print.php: Gibbon invoice statuses **(summary)**.
22. https://www.carmarthenshire.gov.wales/media/1219915/irms-toolkit-for-schools-2019.pdf: IRMS 2019 school retention schedule.
23. https://studentprivacy.ed.gov/faq/under-ferpa-may-educational-agency-or-institution-disclose-education-records-any-its-employees: FERPA and school officials **(summary)**.
24. https://studentprivacy.ed.gov/resources/joint-guidance-application-ferpa-and-hipaa-student-health-records: FERPA/HIPAA joint guidance, December 2019 **(summary)**.
25. https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-is-special-category-data/: ICO on special category data **(summary)**.
26. https://showmeschoolhealth.org/resources/school-nurse-data-collection-considerations/: Missouri DHSS clinic visit outcomes.
27. https://www.nasn.org/nasn-resources/resources-by-topic/school-health-documentation: NASN health documentation (updated September 2024).
28. https://koha-community.org/manual/latest/en/html/circulation.html: Koha lost and damaged items **(summary)**.
29. https://help.assetmanagement.siemens.com/help/Content/Documentation/Maintenance/Asset%20Essentials%20Edu/WO%20Management/Processing-And-Managing-Work-Orders.htm: Brightly work order completion and archiving.
30. https://smarteskwela.com/blog/deped-school-forms-sf1-to-sf10: DepEd school forms SF1–SF10 **(summary; secondary)**.
