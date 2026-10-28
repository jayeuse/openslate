"""Invented names and short staff phrases for a Philippine community development NGO."""

from __future__ import annotations


def _words(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split("|"))


# Real uses of the marker words in program work (plan rule 10). "Pre-assessment" and
# "post-assessment" hold no marker word, so they need no allowance.
TRADE_PHRASES = (
    "pilot test",
    "sample survey",
    "test run of the early warning system",
    "random sample",
)

FIRST_NAMES = _words(
    "Maria|Jose|Ana|Juan|Rosalinda|Ramon|Liza|Eduardo|Josefina|Antonio|Marites|Rogelio"
    "|Cristina|Danilo|Evangeline|Ferdinand|Gloria|Herminio|Imelda|Jericho|Kristel|Leonardo"
    "|Marilou|Nestor|Ofelia|Pedrito|Querubin|Rowena|Severino|Teodora|Ulysses|Virgilio"
    "|Wilma|Xandro|Yolanda|Zaldy|Aurora|Benjie|Corazon|Dionisio|Erlinda|Florante|Gemma"
    "|Honorio|Irene|Jojo|Karen|Lorenzo|Maricel|Noel|Ophelia|Perla|Rhea|Salvador|Trinidad"
    "|Vilma|Wilfredo|Analyn|Bernardo|Charito|Dolores|Ernesto|Felicidad|Gregorio"
)
LAST_NAMES = _words(
    "Dela Cruz|Bautista|Ocampo|Mendoza|Villanueva|Ramos|Castillo|Fernandez|Aquino|Navarro"
    "|Torres|Gonzales|Santiago|Pascual|Manalo|Dimaculangan|Macaraeg|Panganiban|Tolentino"
    "|Soriano|Salazar|Magbanua|Lacson|Dizon|Cabrera|Sison|Alcantara|Mercado|Gonzaga|Esguerra"
    "|Abad|Reyes|Valdez|Medina|Leung|Arceo|Buenaventura|Cortez|Delos Reyes|Evangelista"
    "|Francisco|Galang|Hernandez|Ilagan|Jimenez|Katigbak|Lumbao|Malabanan|Nepomuceno"
    "|Obispo|Padilla|Quimpo|Rosales|Samonte|Tanedo|Umali|Velasco|Yap|Zamora|Agbayani"
)
MIDDLE_INITIALS = tuple("ABCDEGLMPRST")
CITIES = _words(
    "Dalisay City|San Lorenzo|Liwanag|Bagong Pag-asa|Marahan City|Tagpuan|Santa Ines"
    "|Malinis|Port Salcedo|Banaag"
)
PROVINCES = ("Marahan", "Tagpuan")
MUNICIPALITIES = _words("Dalisay|Liwanag|San Lorenzo|Malinis|Port Salcedo|Banaag")
BARANGAYS = _words(
    "Malinao|Poblacion Norte|Bagong Silang|Pulo|Tabing-Ilog|Sampaguita|Mabini|Talisay"
    "|Bucana|Kawayan|Daungan|Mataas na Lupa|Bagumbayan|Lawaan|Sapang Bato|Pantalan"
)
# (Funder or partner name, organization type, role, grant code prefix)
FUNDERS = (
    ("Northgate Foundation", "Foundation", "Funder", "NGF"),
    ("Meridian Relief Fund", "Foundation", "Funder", "MRF"),
    ("Coastal Resilience Trust", "Foundation", "Funder", "CRT"),
    ("Solace Bank Corporate Foundation", "Corporate", "Corporate partner", "SBCF"),
    ("Eastwind Development Cooperation Agency", "Bilateral or multilateral donor", "Funder",
     "BDA"),  # fmt: skip
    ("Hollow Wood Family Fund", "Foundation", "Funder", "HWF"),
    ("Emberline Community Fund", "Foundation", "Funder", "ECF"),
    ("Municipality of Dalisay", "Government agency", "Funder", "LGU"),
    ("Tidewater Shipping Corporation", "Corporate", "Corporate partner", "TSC"),
    ("Brightfield Telecom Foundation", "Corporate", "Corporate partner", "BTF"),
)
PARTNER_NAMES = _words(
    "Bayanihan Women's Cooperative|Fisherfolk Association|Sinag Youth Volunteers"
    "|Parents and Teachers Association|Farmers Multi-Purpose Cooperative|Senior Citizens Club"
    "|Persons with Disability Federation|Barangay Health Workers Network"
    "|Out-of-School Youth Circle|Mothers Savings Group"
)
COORDINATION = _words(
    "Municipal DRRM Office|Provincial Social Welfare Office|Shelter Cluster Hub"
    "|Schools Division Office|Municipal Agriculture Office|Food Security Cluster"
)
PROJECTS = (
    ("FCDF-LIV-24-02", "Women's Micro-enterprise Recovery", "Livelihood"),
    ("FCDF-EDU-25-01", "Learning Recovery Tutoring", "Education support"),
    ("FCDF-ER-26-01", "Typhoon Aldren Response", "Disaster response"),
    ("FCDF-DRR-25-02", "Community Early Warning", "DRR and preparedness"),
    ("FCDF-EDU-25-03", "Scholarship Support", "Education support"),
    ("FCDF-LIV-25-04", "Fisherfolk Gear Replacement", "Livelihood"),
    ("FCDF-WASH-26-01", "School Handwashing Stations", "DRR and preparedness"),
    ("FCDF-ER-25-02", "Flood Response, Barangay Cluster B", "Disaster response"),
)
CAMPAIGNS = (
    ("Light a Classroom Year-End Appeal", "Year-end appeal"),
    ("Typhoon Aldren Emergency Appeal", "Emergency appeal"),
    ("Kasama Monthly Givers Circle", "Monthly giving drive"),
    ("Back-to-School Kits Drive", "Corporate partnership"),
    ("Sewing Futures Livelihood Appeal", "Major gifts"),
    ("Harvest Dinner", "Event"),
    ("Run for Resilience 5K", "Peer-to-peer"),
    ("Coastal Schools Rebuild Fund", "Emergency appeal"),
    ("Holiday Food Pack Match", "Corporate partnership"),
    ("Scholars' Circle Major Gifts", "Major gifts"),
    ("Employee Payroll Giving, Solace Bank", "Corporate partnership"),
    ("Birthday Fundraiser Pages", "Peer-to-peer"),
    ("Rainy Season Readiness Appeal", "Emergency appeal"),
    ("Lent Giving Week", "Year-end appeal"),
)
ACTIVITIES = {
    "Training": ("Basic bookkeeping training", "Seed capital orientation",
                 "First aid training for responders", "Product costing workshop"),
    "Community meeting": ("Community validation of the beneficiary list",
                          "Barangay DRR planning workshop", "Complaints desk briefing"),
    "Distribution": ("Food pack distribution", "Hygiene kit distribution",
                     "Shelter kit distribution", "Multipurpose cash payout"),
    "Tutoring session": ("After-school reading tutoring", "Math catch-up class"),
    "Assessment": ("Rapid needs assessment", "Pre-assessment of trainees",
                   "Post-assessment of trainees", "Pilot test of the KoBo registration form"),
    "Monitoring visit": ("Post-distribution monitoring visit", "Livelihood follow-up visit"),
    "Coordination meeting": ("Cluster coordination meeting", "Parent-teacher consultation"),
    "Drill": ("Evacuation drill with Grade 5", "Early warning drill"),
}  # fmt: skip
INDICATORS = (
    ("Output", "Number", "# of households receiving multipurpose cash, by sex of household head"),
    ("Outcome", "Percentage", "% of trained women operating a business 6 months after training"),
    ("Outcome", "Percentage", "% of supported learners promoted to the next grade"),
    ("Outcome", "Average", "Average monthly household income of livelihood participants (₱)"),
    ("Output", "Number", "# of hygiene kits distributed"),
    ("Outcome", "Percentage", "% of households reporting kit contents met their needs (PDM)"),
    ("Output", "Percentage", "% of complaints closed within 30 days"),
    ("Outcome", "Number", "# of communities with a functional early warning committee"),
    ("Output", "Number", "# of volunteers trained in first aid"),
    ("Outcome", "Percentage", "% of scholars with at least 85% attendance"),
    ("Output", "Number", "# of learners reached by tutoring, by sex and grade"),
    ("Impact", "Percentage", "% of households with an evacuation plan"),
)
SUPPLIERS = (
    ("Masagana Rice Trading", "Food and NFI"),
    ("Bayside Hardware and Construction Supply", "Construction materials"),
    ("Sikat Printing Press", "Printing"),
    ("Tabing-Ilog Trucking Services", "Trucking"),
    ("Liwanag Events Place and Catering", "Catering and venue"),
    ("Kompyuter Hub IT Solutions", "IT equipment"),
    ("Dalisay General Merchandise", "Food and NFI"),
    ("Pantalan Logistics Corporation", "Trucking"),
    ("Bagong Araw Food Supply Inc.", "Food and NFI"),
    ("Tibay Roofing and Steel Co.", "Construction materials"),
    ("Hiraya Training and Consultancy", "Consultants"),
    ("Kalasag Tarpaulin Printing", "Printing"),
    ("Agos Water Systems Inc.", "Food and NFI"),
    ("Banaag Solar Lighting Corporation", "IT equipment"),
    ("Malinis Hygiene Products Trading", "Food and NFI"),
    ("Talisay Function Hall and Catering", "Catering and venue"),
    ("Daluyong Marine Supply", "Food and NFI"),
    ("Kawayan Builders Depot", "Construction materials"),
)
PAYEES = _words(
    "Liwanag Bakeshop|Pump boat operator, Pulo Island|Sari-sari store, Purok 3"
    "|Jeepney charter, Dalisay terminal|Load retailer, Poblacion|Lodging house, Dalisay town"
    "|Barangay Malinao multipurpose hall|Carinderia near the evacuation center"
    "|Photocopy shop, Mabini Street|Tricycle drivers' association|Hardware store, Talisay"
    "|Gasoline station, national highway"
)
PURPOSES = (
    "Venue, meals and transport for a two-day livelihood training",
    "Boat hire and fuel for the island distribution",
    "Snacks and materials for the community validation meeting",
    "Meals for volunteers at the weekend repacking",
    "Honoraria and meals for the early warning drill",
    "Transport and lodging for the post-distribution monitoring",
    "Materials for the after-school tutoring sessions",
    "Trucking of food packs from the warehouse to the sites",
)
GRANT_CONDITIONS = (
    "Quarterly financial reports; no more than 10% variance between budget lines.",
    "Visibility: the funder's logo on distribution banners and kits.",
    "Final report within 120 days after the period ends.",
    "Prior approval for any equipment over ₱50,000.",
    "Realignment above 10% of a line needs the funder's written approval.",
)
FEEDBACK = {
    "Assistance request": "Household asked to be included in the next distribution round.",
    "Information request": "Caller asked when the next payout will happen in their barangay.",
    "Exclusion complaint": "Resident says the family was left off the validated list.",
    "Quality or quantity complaint": "Family reports the food pack was short of canned fish.",
    "Appreciation": "Thank-you message from the parents' group after the school kit day.",
    "Staff or volunteer conduct": "Concern about how a volunteer spoke to people in the queue.",
    "Safeguarding/PSEA": "Concern reported through the hotline; referred to the safeguarding "
                         "focal point.",
    "Fraud or diversion": "Report that kits were resold at a market stall; checking the lists.",
}  # fmt: skip
RESPONSES = (
    "Explained the selection criteria and the next validation date.",
    "Added to the Round 3 list after a household visit.",
    "Replacement items delivered at the next distribution.",
    "Referred to the barangay social worker; follow-up call done.",
    "Reply sent; no further action needed.",
)
JUSTIFICATIONS = (
    "Needed for the next distribution round.",
    "Replaces kits used in the typhoon response.",
    "Training materials for the new batch.",
    "Only supplier on the island who can deliver this week.",
    "Stock is below the pre-positioning level.",
)
NOTES = {
    "resource_mobilization": (
        "Donor asked for receipt by email, not post.",
        "Called to thank; asked about the scholarship program.",
        "Bank reference matched on the deposit slip.",
        "Prefers SMS reminders for the monthly gift.",
        "Gift came through the online page during the appeal.",
        "Corporate match to follow next month.",
    ),
    "grants_partnerships": (
        "Funder asked for disaggregation by age for Q2.",
        "Budget line 2.3 near ceiling, flag for realignment request.",
        "Partner MOU renewal sent for signature.",
        "Due diligence documents received; checking the audit report.",
        "Interim report accepted with minor comments.",
    ),
    "programs": (
        "HH not home during validation; revisit Thursday.",
        "Name spelled differently on ID; kept ID spelling.",
        "Proxy claimed for elderly mother; authorization letter on file.",
        "Moved from Round 2 to Round 3 list, was in evacuation center.",
        "Road to the site flooded; moved to the barangay hall.",
        "Attendance sheet scanned and filed.",
    ),
    "meal": (
        "Figures checked against the attendance sheets.",
        "Partner report arrived late; used the KoBo export.",
        "Two duplicate entries removed before the total.",
        "Spot check of a random sample of 20 households done.",
    ),
    "finance": (
        "Liquidation short by 1,250; cashier to collect refund Friday.",
        "Hardware store OR is handwritten; asked supplier for a proper official receipt.",
        "Charged to the appeal fund, not the grant.",
        "Bank transfer reference attached.",
        "Receipts complete; posted to the grant ledger.",
    ),
    "procurement": (
        "Three quotes attached. Lowest cannot deliver before the 15th; recommending second.",
        "Delivery checked against the PO; two cartons short.",
        "Supplier asked for a 30-day payment term.",
        "Price list updated after the typhoon.",
    ),
    "volunteer_engagement": (
        "Available on weekends only.",
        "Completed the first aid refresher.",
        "Helped at three repacking shifts this month.",
        "Asked to join the data encoding team.",
    ),
    "executive_office": (
        "Handled by the safeguarding focal point.",
        "Shared the outcome with the complainant by phone.",
        "Discussed at the management meeting.",
    ),
}  # fmt: skip
ACCESS_NOTES = (
    "Reachable by boat only at high tide.",
    "Road floods in heavy rain; use the upper road.",
    "Barangay hall available for distributions.",
    "Two-hour drive from the field office.",
    "Mobile signal only near the chapel.",
)
