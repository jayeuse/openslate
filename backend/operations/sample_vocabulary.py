"""Business vocabulary for Harbor Operations Group record text.

Names are invented. Places are real Philippine localities; companies, streets and
people are not real businesses or persons. Lists are pipe-separated for density.
"""

from __future__ import annotations


def _w(text: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in text.split("|"))


# Real trade phrases that contain a word the generator otherwise never uses.
TRADE_PHRASES = ("pressure test", "load test", "insulation test", "oil sample")

INTERNAL_DOMAIN = "harbor-ops.example"

TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "sales": _w("Marina Santos|Carlo Reyes|Mika Villanueva|Nico Bautista|Bea Ramirez"),
    "service": _w("Paolo Dela Cruz|Ana Castillo|Luis Mendoza|Iris Navarro|Joel Garcia"),
    "field": _w("Sofia Villareal|Ramon Flores|Ella Mercado|Marco Lim|Nina Aquino"),
    "inventory": _w("Gabriel Tan|Lara Fernandez|Enzo Rivera|Chloe Ramos|Miguel Ong"),
    "purchasing": _w("Isabel Cruz|David Santiago|Tessa Valdez|Andre Gomez|Leah Sy"),
    "finance": _w("Rafael Dominguez|Celine Uy|Victor Pascual|Kara Chua|Noel Bautista"),
}

# Job titles per team: the lead's title first, then the members' titles in order.
TEAM_TITLES = {
    "sales": ("Sales Manager", "Account Executive", "Account Executive", "Sales Coordinator",
              "Inside Sales Representative"),
    "service": ("Customer Service Manager", "Service Coordinator", "Customer Service Specialist",
                "Customer Service Specialist", "Service Dispatcher"),
    "field": ("Field Operations Supervisor", "Senior Field Technician", "Field Technician",
              "Field Technician", "Maintenance Planner"),
    "inventory": ("Inventory Manager", "Warehouse Supervisor", "Inventory Clerk",
                  "Inventory Clerk", "Stock Controller"),
    "purchasing": ("Purchasing Manager", "Senior Buyer", "Buyer", "Purchasing Officer",
                   "Purchasing Assistant"),
    "finance": ("Finance Manager", "Accountant", "Accounts Receivable Clerk",
                "Accounts Payable Clerk", "Billing Specialist"),
}  # fmt: skip
GUEST_DOMAINS = ("kalinaw-audit.example", "tanglaw-advisory.example", "banaag-partners.example")

# Invented company name stems, checked against well-known Philippine brands.
COMPANY_STEMS = _w(
    "Northstar|Bayview|Tidewater|Silangan|Kalinaw|Marikit|Anahaw|Hiraya|Bagwis|Dalisay"
    "|Sierra Madre|Lakandula|Dalampasigan|Taal Ridge|Pinagpala|Maharlika Bay|Kaagapay"
    "|Tanglaw|Banaag|Pantalan Point|Mabuhay Coast|Dapithapon|Katipan|Laguna Grove|Masagana"
    "|Harana|Balangay|Salinlahi|Dagatan|Amihan|Hilaga|Bituin|Kislap|Luntian|Makisig"
    "|Payapa|Sinag|Tagumpay|Ulayaw|Yakal"
)
# Customer trades per segment; segment names match the catalog options.
CUSTOMER_TRADES = {
    "Marine": _w(
        "Marine Supply|Shipyard|Port Services|Fishing Corp.|Boat Works|Marine Engineering"
        "|Stevedoring|Ferry Lines"
    ),
    "Food service": _w(
        "Coastal Foods|Cold Chain|Bakeshop|Catering|Seafood Processing|Commissary|Food Hall"
        "|Ice Plant"
    ),
    "Agriculture": _w(
        "Agri Traders|Farms|Grain Center|Poultry|Rice Mill|Feed Mill|Banana Growers|Coco Products"
    ),
    "Public sector": _w(
        "Water District|Port Authority Office|Provincial Hospital|State College|Municipal Market"
        "|Public Terminal|Engineering District|Health Center"
    ),
}
COMPANY_SUFFIXES = ("", " Inc.", " Corp.")
SUPPLIER_TRADES = _w(
    "Industrial Supply|Electrical Trading|Safety Products|Hydraulics Center|Packaging Corp."
    "|Fasteners & Tools|Refrigeration Parts|Pumps & Valves"
)

FIRST_NAMES = _w(
    "Liza|Andre|Bea|Nico|Mara|Paolo|Jasmine|Rico|Trina|Arnel|Kristine|Jerome|Maricel|Dennis"
    "|Angelica|Ronaldo|Shiela|Mark|Grace|Jomar|Rowena|Carlo|Joy|Ferdinand|Lorna|Allan|Ivy"
    "|Rey|Camille|Edwin|Hazel|Jun|Katrina|Leo|Melody|Noel|Patricia|Ramil|Sarah|Teodoro"
    "|Venus|Wilfredo|Aileen|Benjie|Cherry|Dante|Elaine|Gilbert|Hannah|Irene|Jayson|Karla"
    "|Lester|Mylene|Nestor|Olivia|Pia|Randy|Sheryl|Vince"
)
LAST_NAMES = _w(
    "Cruz|Lim|Navarro|Garcia|Santos|Reyes|Mendoza|Aquino|Bautista|Castillo|Dizon|Espiritu"
    "|Fajardo|Gonzaga|Hernandez|Ilagan|Jimenez|Katigbak|Lacson|Manalo|Nepomuceno|Ocampo"
    "|Pangilinan|Quizon|Ramos|Salazar|Tolentino|Umali|Valdez|Wong|Yap|Zamora|Agbayani"
    "|Buenaventura|Cabrera|Dela Rosa|Estrada|Francisco|Guevarra|Lopez|Macaraeg|Natividad"
    "|Orense|Pascual|Quiambao|Rivera|Sison|Tan|Uy|Villanueva|Abad|Bernardo|Co"
    "|Dimaculangan|Enriquez|Flores|Gatchalian|Hidalgo|Isidro|Javier"
)

PLACES = _w(
    "Navotas|Valenzuela|Malabon|Taguig|Pasig|Paranaque|Calamba|Santa Rosa|Batangas City|Lipa"
    "|San Fernando|Clark|Subic|Malolos|Cebu City|Mandaue|Lapu-Lapu|Iloilo City|Bacolod"
    "|Tacloban|Cagayan de Oro|Davao City|Panabo|General Santos|Zamboanga City"
)
STREETS = _w(
    "Mabini St.|Rizal Ave.|Bonifacio Drive|Luna St.|Del Pilar St.|Quezon Blvd.|Burgos St."
    "|MacArthur Highway|National Road|Port Access Road|Industrial Ave.|Coastal Road"
)
SITE_LABELS = {
    "Office": _w("head office|sales office|admin office"),
    "Warehouse": _w("warehouse|cold store|distribution center"),
    "Plant": _w("processing plant|packing plant|production plant"),
    "Retail": _w("branch|outlet|retail store"),
}

# Equipment types: name, asset-tag prefix, typical faults, typical repair actions.
EQUIPMENT_TYPES = tuple(
    (name, prefix, _w(faults), _w(actions))
    for name, prefix, faults, actions in (
        ("Reach truck", "RT", "mast chain slipping|battery not holding charge|hydraulic leak",
         "Replace mast chain|Service battery pack|Reseal lift cylinder"),
        ("Forklift", "FL", "brakes pulling left|engine overheating|fork tilt drifting",
         "Reline brakes|Flush cooling system|Rebuild tilt valve"),
        ("Blast chiller", "BC", "not holding −18 °C|door gasket torn|evaporator icing up",
         "Replace door gasket|Defrost and clean evaporator|Recharge refrigerant"),
        ("Dock leveler", "DL", "lip not extending|hydraulic pump noisy|platform drifting down",
         "Replace lip hinge pin|Rebuild hydraulic pump|Adjust holding valve"),
        ("Reefer container", "RC", "alarm on return air|compressor tripping|door seal leaking",
         "Replace return-air sensor|Rewire compressor contactor|Replace door seal"),
        ("Generator set", "GS", "failing to start on transfer|low oil pressure|unstable voltage",
         "Replace starter battery|Change oil and filters|Tune voltage regulator"),
        ("Air compressor", "AC", "pressure dropping|oil in air line|safety valve popping",
         "Replace intake filter|Service oil separator|Recalibrate pressure switch"),
        ("Pallet jack", "PJ", "not lifting under load|wheel bearing worn|handle spring broken",
         "Replace pump seal kit|Replace load wheels|Replace handle spring"),
        ("Ice machine", "IM", "low ice output|water leaking at base|irregular cube size",
         "Descale water circuit|Replace drain hose|Adjust harvest timer"),
        ("Conveyor line", "CV", "belt tracking off|motor overheating|roller seized",
         "Re-track belt|Replace drive motor bearing|Replace seized rollers"),
        ("Water pump", "WP", "losing prime|mechanical seal leaking|low discharge pressure",
         "Replace foot valve|Replace mechanical seal|Clean impeller"),
        ("Scissor lift", "SL", "platform not level|emergency stop faulty|slow descent",
         "Level platform sensors|Replace e-stop switch|Clean descent valve"),
    )
)  # fmt: skip
EQUIPMENT_MAKERS = _w("Kaiju|Norvane|Palaris|Tarsier|Veltro|Bravado")
INSPECTION_TYPES = _w(
    "Post-repair check|Monthly safety inspection|Load test|Pressure test"
    "|Electrical insulation test|Temperature log review|Pre-season inspection"
    "|Oil sample and wear check"
)
MAINTENANCE_PLANS = (
    ("Weekly", "visual and lubrication check"),
    ("Monthly", "PMS"),
    ("Quarterly", "PMS and filter change"),
    ("Semi-annual", "overhaul inspection"),
    ("Annual", "certification and load test"),
)

# Products per catalog category: SKU code, items, variants.
PRODUCTS = {
    "Electrical": ("EL", _w(
        "Circuit breaker|Contactor|Cable gland|Terminal block|LED high-bay light|Extension reel"
        "|Motor starter|Control relay|Junction box|Photo sensor|Surge protector|Emergency light"
        "|Limit switch|Push button station|Power cable|Earthing clamp|Fuse holder|Timer relay"
        "|Cable tray bracket|Selector switch"
    ), _w("10 A|16 A|20 A|32 A|IP65|IP67|3-phase|single-phase")),
    "Hydraulics": ("HY", _w(
        "Hydraulic hose|Seal kit|Gear pump|Directional valve|Pressure gauge|Quick coupler"
        "|Return filter|Cylinder rod seal|Hose fitting|Relief valve|Flow control valve"
        "|Suction strainer|Hydraulic oil|Accumulator bladder|Pump coupling|Check valve"
        "|Hand pump|Manifold block|Breather cap|Ball valve"
    ), _w('1/4"|3/8"|1/2"|3/4"|ISO 46|ISO 68|2-wire|4-wire')),
    "Safety": ("SF", _w(
        "Safety harness|Hard hat|Safety shoes|Cut-resistant gloves|Ear muffs|Face shield"
        "|Reflective vest|Fire extinguisher|First aid kit|Lockout kit|Safety goggles"
        "|Respirator cartridge|Wheel chock|Traffic cone|Eye wash station|Fall arrester"
        "|Safety sign|Spill kit|Welding gloves|Chemical apron"
    ), _w("size S|size M|size L|size XL|class 2|class 3|10 lb|20 lb")),
    "Packaging": ("PK", _w(
        "Stretch film|Carton box|Packing tape|Pallet wrap|Bubble wrap roll|Corner board"
        "|Poly strap|Shrink bag|Ice pack|Insulated liner|Label roll|Tamper seal|Void fill"
        "|Foam sheet|Kraft paper roll|Vacuum pouch|Cold chain box|Mesh bag|Twine spool"
        "|Pallet cover"
    ), _w("small|medium|large|500 mm|18 in|48 in|heavy duty|food grade")),
}  # fmt: skip

WAREHOUSE_NAMES = {
    "Metro Manila": _w(
        "Navotas Distribution Center|Valenzuela Warehouse|Taguig Cross-dock|Pasig Parts Store"
    ),
    "Central Luzon": _w(
        "Clark Logistics Hub|San Fernando Warehouse|Subic Port Store|Malolos Depot"
    ),
    "Central Visayas": _w("Mandaue Hub|Cebu Port Store|Lapu-Lapu Cold Store|Talisay Depot"),
    "Davao": _w("Davao Cold Store|Panabo Depot|Toril Warehouse|Sasa Wharf Store"),
}

QUOTE_OFFERS = _w(
    "cold-chain packaging, 3-month supply|dock leveler service package|safety equipment refresh"
    "|annual PMS for forklift fleet|blast chiller installation|hydraulic spares kit"
    "|reefer monitoring upgrade|warehouse lighting retrofit|packaging materials, quarterly"
    "|generator set rental, 6 months|conveyor belt replacement|spill response kits for 4 sites"
)
ORDER_ITEMS = _w(
    "cases of stretch film|units of seal kits|boxes of cut-resistant gloves|rolls of pallet wrap"
    "|units of LED high-bay lights|sets of reflective vests|cartons of ice packs"
    "|units of pressure gauges|drums of hydraulic oil|units of fire extinguishers"
)
CONTRACT_TIERS = _w("Gold|Silver|Standard|Essential")
REQUEST_UPDATES = (
    "Technician booked for {day} {hour} AM.",
    "Parts ordered; supplier confirmed delivery in {days} days.",
    "Customer confirmed the unit is back to normal operation.",
    "Visited site; issue traced to a worn part, replacement quoted.",
    "Called {name} to confirm access to the site on {day}.",
    "Waiting on customer approval of the repair quote.",
    "Temporary fix applied; permanent repair scheduled for {day}.",
    "Unit checked after repair and running within limits.",
    "Escalated to Field Operations lead for a second opinion.",
    "Sent photos and findings to the customer's facilities team.",
)
WEEKDAYS = _w("Monday|Tuesday|Wednesday|Thursday|Friday|Saturday")
EXPENSES = {
    "Travel": _w(
        "Fuel, {place} site visit|Toll fees, {place} delivery run"
        "|Airfare to {place} for supplier audit|Hotel, {place} installation"
    ),
    "Supplies": _w(
        "Printer ink and paper, {place} office|Cleaning supplies, {place} warehouse"
        "|Batteries for {place} handheld scanners|Label stock for {place} dispatch"
    ),
    "Maintenance": _w(
        "Aircon cleaning, {place} office|Tire repair, {place} delivery van"
        "|Plumbing repair, {place} warehouse|Door lock replacement, {place} store"
    ),
    "Meals": _w(
        "Team lunch after {place} inventory count|Client lunch, {place}"
        "|Overtime meals, {place} month-end close|Snacks for {place} safety briefing"
    ),
}
MOVEMENT_REASONS = {"Purchase receipt": "Received", "Quality check": "Quality hold",
                    "Put away": "Put away"}  # fmt: skip
