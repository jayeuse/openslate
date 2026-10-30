"""Invented names and short city hall phrases for the City Government of Dalisay (research §9).

No name here belongs to a real official, business or brand; places are invented barangays
and streets of a fictional city.
"""

from __future__ import annotations


def _words(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split("|"))


# Real uses of the marker words in city hall work (plan rule 10).
TRADE_PHRASES = ("soil test", "concrete cylinder test", "water sample", "bacteriological test")

FIRST_NAMES = _words(
    "Marites|Lorna|Jocelyn|Rommel|Gina|Nestor|Elvira|Rogelio|Wilma|Danica|Jomar|Kimberly"
    "|Alvin|Mylene|Reynaldo|Cristina|Leonora|Marvin|Analyn|Bernard|Charito|Dennis|Erlinda"
    "|Gilbert|Herminia|Isidro|Janet|Lito|Merlie|Norberto|Ofelia|Pacita|Rosario|Socorro"
    "|Ulysses|Virgilio|Yolanda|Zenaida|Ariel|Carmela|Dindo|Edgardo|Florante|Gemma"
)
LAST_NAMES = _words(
    "Abella|Bacani|Cabrera|Espiritu|Francisco|Gatdula|Hernandez|Ibañez|Jimenez|Lacsamana"
    "|Magbanua|Nepomuceno|Olivares|Pineda|Quinto|Rivera|Samonte|Tabora|Umali|Velasco|Yumul"
    "|Zamora|Agbayani|Baltazar|Calimlim|Dimaano|Evangelista|Fernando|Geronimo|Hilario"
    "|Inocencio|Jaucian|Lualhati|Malabanan|Nacpil|Ordoñez|Pacheco|Quijano|Uy|Ybañez|Zulueta"
    "|Alonzo|Bunag|Cajucom|Dumlao|Escaño|Fuentes|Gabriel"
)
BUSINESS_WORDS = _words(
    "Mabuhay|Tala|Bituin|Masagana|Pag-asa|Kalinaw|Sampaguita|Bagong Araw|Liwanag|Hiyas"
    "|Ginintuan|Dakila|Malaya|Tagumpay|Biyaya|Harana|Silangan|Kalikasan|Bukid"
    "|Sinag|Anahaw|Mutya|Dalisdis|Kaibigan|Lingkod|Banaag|Himig|Tanglaw|Alon|Bahaghari"
)
# Line of business: the word a sign uses after the owner's or the shop's name.
BUSINESS_SIGNS = {
    "Sari-sari and convenience store": "Sari-sari Store",
    "Carinderia or eatery": "Carinderia",
    "Bakery": "Bakery",
    "Hardware and construction supply": "Hardware and Construction Supply",
    "Pharmacy": "Pharmacy",
    "Water refilling station": "Water Refilling Station",
    "Laundry shop": "Laundry Shop",
    "Barbershop or salon": "Salon and Barbershop",
    "Auto repair shop": "Auto Repair Shop",
    "Rice retailer": "Rice Dealer",
    "Printing and internet shop": "Printing and Internet Cafe",
    "Boarding house": "Boarding House",
    "Medical clinic": "Medical Clinic",
    "Private school": "Learning Center",
    "Pawnshop or lending": "Pawnshop",
    "Gasoline station": "Fuel Station",
    "Warehouse": "Warehousing",
    "General contractor": "Builders",
    "Space lessor": "Commercial Spaces",
    "Professional services": "Accounting Services",
}
STREETS = _words(
    "Mabini Street|Rizal Avenue|Bonifacio Street|Luna Street|Acacia Street|Molave Street"
    "|Narra Street|Sampaguita Street|Kalayaan Avenue|National Road|Ilang-Ilang Street"
    "|Gumamela Street|Talisay Street|Burgos Street|Del Pilar Street|Santol Street"
    "|Mangga Street|Kamagong Street|Dao Street|Riverside Drive|Market Road|Chapel Road"
)
SUPPLIERS = _words(
    "Tala Office Supplies Trading|Bagwis Construction and Supply|Malinaw Printing Services"
    "|Kalasag Security Agency|Banaag Electrical Supply|Lakas Hardware Corporation"
    "|Sinag Computer Center|Anahaw Builders and Development Corp.|Masagana Catering Services"
    "|Hiraya Janitorial Services|Bukal Water Systems|Dakila Petroleum Trading"
    "|Silangan Motor Works|Tanglaw Lighting Solutions|Dagat Asphalt and Aggregates"
    "|Pinagpala Sand and Gravel|Matatag Steel Trading|Habagat Engineering Consultants"
    "|Luntian Landscaping Services|Bayani Trucking Services|Kislap Electronics"
    "|Haligi Concrete Products|Talampas Construction Corporation|Dalampasigan Traders"
    "|Mapagkalinga Medical Supply|Kalinga Uniforms and Garments|Sigla Sports Supply"
    "|Ugnay Telecom Services|Tibay Pipes and Fittings|Bantay Fire Equipment Trading"
)
# Branches of a supplier outside the city, as their letterheads name them.
BRANCH_PLACES = _words("Santa Cruz|Bagong Pook|San Isidro Norte|Laguerta|Malabon Ilaya")
PROCUREMENT_ITEMS = (
    ("Office supplies for the second quarter", "General Services Office", "Goods", 180000),
    ("A4 bond paper, 70gsm, 300 reams", "General Services Office", "Goods", 95000),
    ("Toner cartridges for the city hall printers", "City Treasurer's Office", "Goods", 120000),
    ("100W LED streetlight luminaires, 60 units", "City Engineering Office", "Goods", 1800000),
    ("Cold-mix asphalt, 400 bags", "City Engineering Office", "Goods", 260000),
    ("910mm reinforced concrete culvert pipes", "City Engineering Office",
     "Infrastructure contractor", 2400000),
    ("Gravel and sand for road shoulders", "City Engineering Office", "Goods", 450000),
    ("Portland cement, 40kg bags", "City Engineering Office", "Goods", 380000),
    ("Janitorial supplies for city hall", "General Services Office", "Goods", 140000),
    ("Diesel and gasoline for the motorpool", "General Services Office", "Goods", 900000),
    ("Repair of the dump truck", "City Engineering Office", "Service provider", 350000),
    ("Double-cab pickup, 1 unit", "City Disaster Risk Reduction Office", "Goods", 1950000),
    ("Desktop computers, 12 units", "Business Permits and Licensing", "Goods", 640000),
    ("Catering for the budget hearings", "Sangguniang Panlungsod", "Service provider", 75000),
    ("CCTV installation at city hall", "General Services Office", "Service provider", 1200000),
    ("Desilting of the Acacia Creek drainage canal", "City Engineering Office",
     "Infrastructure contractor", 3500000),
    ("Asphalt overlay of Molave Street", "City Engineering Office",
     "Infrastructure contractor", 8500000),
    ("Security guard services for city hall", "General Services Office", "Service provider",
     1600000),
    ("Rescue equipment for the flood season", "City Disaster Risk Reduction Office", "Goods",
     700000),
    ("Medicines for the barangay health stations", "City Health Office", "Goods", 1100000),
    ("Structural assessment of the public market", "Office of the Building Official",
     "Consulting", 950000),
    ("Filing cabinets for the civil registry", "City Civil Registry", "Goods", 160000),
    ("Fire extinguishers and refills", "General Services Office", "Goods", 210000),
    ("Water quality laboratory services", "City Health Office", "Service provider", 300000),
)  # fmt: skip
SR_DESCRIPTIONS = {
    "Clogged drainage or canal": ("Canal is full of garbage and water is backing up into the "
                                  "street after the rain.", "Drainage grate is blocked; "
                                  "water stays for hours."),
    "Pothole": ("Deep pothole near the corner; two motorcycles already fell.",
                "Several potholes along the road shoulder after the heavy rains."),
    "Streetlight out": ("Streetlight in front of the chapel has been out for a week.",
                        "Three streetlights out along the road; very dark at night."),
    "Uncollected garbage": ("Garbage not collected since Monday.",
                            "Collection truck skipped our street twice this week."),
    "Street flooding": ("Knee-deep flood whenever it rains for an hour.",
                        "Flooding at the low part of the road near the creek."),
    "Fallen tree or branch": ("Large branch fell on the road after the storm.",
                              "Leaning acacia tree touching the power lines."),
    "Streetlight flickering": ("Streetlight keeps turning on and off at night.",),
    "Damaged sidewalk": ("Broken sidewalk slabs in front of the school.",),
    "Illegal dumping": ("Construction debris dumped on the vacant lot overnight.",),
    "Open or missing manhole cover": ("Manhole cover missing; covered only with a plank.",),
    "Damaged road sign": ("Stop sign bent and facing the wrong way.",),
    "Road obstruction": ("Vendor stalls blocking half of the road.",),
    "Illegal construction report": ("Neighbor is building a second floor without a permit.",),
    "Stray animals": ("Pack of stray dogs near the elementary school.",),
    "Leaking water main": ("Water pipe leaking on the street for three days.",),
    "Graffiti": ("Graffiti on the waiting shed walls.",),
}  # fmt: skip
WORK_MATERIALS = {
    "Pothole patching": ("6 bags cold mix", "10 bags cold mix, 1 load gravel", "4 bags cold mix"),
    "Declogging and desilting": ("Manual desilting, 3 sacks silt hauled",
                                 "Declogging tools, 12 sacks silt hauled"),
    "Streetlight repair": ("1 LED luminaire 100W, 1 photocell", "Replaced fuse and photocell"),
    "Tree trimming": ("Chainsaw, 1 truckload of branches hauled",),
    "Sidewalk repair": ("8 bags cement, 1 load sand", "4 bags cement, 1 load gravel"),
    "Manhole cover replacement": ("1 concrete manhole cover",),
    "Special garbage pickup": ("1 truckload hauled to the transfer station",),
    "Sign repair": ("1 sign post, bolts and paint",),
}  # fmt: skip
BUSINESS_FINDINGS = (
    "Fire extinguisher expired, recharge within 7 days.", "Operating without sanitary permit.",
    "Signage installed without permit.", "Fire exit obstructed by stock.",
    "Grease trap not installed.", "No monthly water sample on file.",
    "No bacteriological test result for the last quarter.", "Complied, no findings.",
    "Business moved to another address.", "Exposed wiring at the service entrance.",
)  # fmt: skip
BUILDING_FINDINGS = (
    "Rebar spacing conforms.", "Rear setback 1.2 m vs 2.0 m required.",
    "Added mezzanine not in approved plans.", "Concrete cylinder test results submitted.",
    "Soil test report attached to the file.", "Exposed wiring at the service entrance.",
    "Occupying building without CO.", "Plumbing rough-in conforms to approved plans.",
    "Footing depth conforms.", "Complied, no findings.",
)  # fmt: skip
MEASURE_TITLES = (
    "An ordinance regulating the operation of water refilling stations",
    "An ordinance amending the revenue code on the garbage fee",
    "A resolution authorizing the mayor to sign a memorandum of agreement with the water district",
    "An ordinance declaring a no-parking zone along Mabini Street",
    "A resolution approving the annual investment program",
    "An ordinance prohibiting the burning of garbage in open spaces",
    "A resolution commending the barangay health workers",
    "An ordinance regulating the use of sidewalks by vendors",
    "A resolution requesting the national road office to repair the national road",
    "An ordinance establishing the city scholarship program",
    "An ordinance setting the schedule of fees for the public market stalls",
    "A resolution approving the city disaster risk reduction plan",
    "An ordinance requiring building owners to install rainwater catchment",
    "A resolution accepting the donation of a lot for the barangay hall",
    "An ordinance regulating tricycle routes and fares",
    "A resolution supporting the mass wedding program",
    "An ordinance on the segregation of waste at source",
    "An ordinance granting a tax amnesty on unpaid business taxes",
    "A resolution approving the supplemental budget",
    "An ordinance creating the city tourism office",
)
COUNCILORS = _words(
    "Hon. Leonora Bacani|Hon. Isidro Magbanua|Hon. Gemma Velasco|Hon. Florante Umali"
    "|Hon. Carmela Nepomuceno|Hon. Edgardo Calimlim|Hon. Socorro Pineda|Hon. Dindo Jaucian"
    "|Hon. Zenaida Olivares|Hon. Ariel Samonte"
)
CORRESPONDENTS = _words(
    "Barangay Council of San Roque|Dalisay Water District|Regional Audit Office"
    "|Provincial Engineering Office|Dalisay Central Elementary School|Market Vendors Association"
    "|Dalisay Electric Cooperative|Parish of Santo Niño|Tricycle Operators Association"
    "|Dalisay City Fire Station|Office of the City Mayor"
    "|Dalisay Chamber of Commerce|Senior Citizens Federation|Homeowners Association, Maligaya"
)
SUBJECTS = (
    "Request for road repair", "Invitation to the barangay assembly",
    "Endorsement of the market stall applications", "Request for a copy of an ordinance",
    "Complaint about uncollected garbage", "Transmittal of approved ordinances",
    "Request for flood control assistance", "Audit observation on cash advances",
    "Schedule of the fire safety inspections", "Request for the use of the covered court",
    "Request for certified true copies", "Position paper on the tricycle fare increase",
    "Memorandum on the budget call", "Travel order for the regional seminar",
)  # fmt: skip
NOTES = {
    "business_establishments": ("Moved to the corner unit of the same building.",
                                "Owner asked for the renewal requirements by phone.",
                                "Lease contract on file until next year.",
                                "Changed the trade name on the signboard."),
    "permit_applications": ("Returned: no lease contract. Advised to comply within 5 working days.",
                            "Assessed; order of payment issued; advised to pay at window 3.",
                            "For zoning clearance.", "Complete requirements; for release tomorrow.",
                            "Owner called to follow up on the permit."),
    "business_inspections": ("Owner present during the inspection.",
                             "Recheck after 7 days.", "Store closed at the time of the visit.",
                             "Fire extinguisher tag checked."),
    "enforcement_notices": ("Served personally to the owner.", "Received by the store manager.",
                            "Owner promised to comply within the week."),
    "building_permits": ("For L&G evaluation.", "Returned for structural computations.",
                         "Fire safety evaluation clearance received.",
                         "Signed by the Building Official."),
    "building_inspections": ("Contractor present at the site.", "Photos uploaded to the folder.",
                             "Next stage inspection to follow."),
    "service_requests": ("Resident confirmed the repair by phone.", "Waiting for the rain to stop.",
                         "Barangay captain informed.", "Caller will send photos."),
    "work_orders": ("Crew 2 scheduled Thu AM, 6 bags cold mix.", "Finished before noon.",
                    "Road closed for two hours during the work.", "Waiting for the backhoe."),
    "payment_orders": ("Paid at window 3.", "Taxpayer asked for installments.",
                       "Assessment explained to the taxpayer."),
    "official_receipts": ("Paid at window 3.", "Check payment; cleared after 3 days.",
                          "Paid through the online payment link."),
    "deposit_reports": ("Deposited at the depository bank the next morning.",
                        "Checks listed separately.", "Counted with the cashier."),
    "payment_releases": ("Released to the authorized representative.",
                         "Credited through the bank.", "Check picked up by the supplier."),
    "appropriations": ("Certified: appropriation exists.", "Augmented by the supplemental budget.",
                       "Balance checked against the registry of obligations."),
    "obligation_requests": ("Certified: appropriation exists.", "Returned: wrong account code.",
                            "Forwarded to accounting."),
    "disbursement_vouchers": ("Pre-audited, lacking IAR, returned to GSO.", "Journal entry posted.",
                              "Forwarded to CTO for fund certification.",
                              "For the mayor's approval."),
    "suppliers": ("Registration renewed.", "Submitted the latest tax clearance.",
                  "Updated the contact person."),
    "purchase_requests": ("Item is in the annual procurement plan.",
                          "Specifications attached.", "Budget cleared by the budget office."),
    "procurement_projects": ("Posted on the bulletin board and the procurement portal.",
                             "Two bidders attended the pre-bid conference.",
                             "Evaluation report signed by the BAC."),
    "bids": ("Bid security attached.", "Received before the deadline.",
             "Complete eligibility documents."),
    "purchase_orders": ("Supplier conformed the same day.", "Supplier asked for an extension.",
                        "Delivered to the warehouse."),
    "acceptance_reports": ("Delivered complete; for inspection.", "Counted with the supplier.",
                           "Items tagged and recorded."),
    "communications": ("Routed for appropriate action.", "Copy furnished the council.",
                       "Filed in the records room.", "Reply sent by email."),
    "legislative_measures": ("Laid on the table pending public hearing.",
                             "Referred to the committee.", "Copies given to the members."),
    "civil_registry": ("Documents complete.", "Supporting affidavit attached.",
                       "Copy sent to the national registry with the monthly batch."),
}  # fmt: skip
PAYEES = _words(
    "Dalisay Electric Cooperative|Dalisay Water District|Ugnay Telecom Services"
    "|Dalisay City Savings Bank|Employees' Cooperative of Dalisay"
)
INCIDENTAL_PAYEES = _words(
    "Barangay Council of San Roque|Dalisay Central Elementary School"
    "|Senior Citizens Federation|Market Vendors Association|Parish of Santo Niño"
)
