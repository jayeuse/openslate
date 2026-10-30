"""Words and catalog facts for an invented Midwest sauce and condiments plant (research §9).

Every company, product, supplier and person is invented; hosts use reserved .example names.
"""

from __future__ import annotations

# Real uses of marker words in plant work (plan: trade phrases), as people write them.
TRADE_PHRASES = (
    "metal detector test",
    "ph retest",
    "test kitchen",
    "retain sample",
    "sample size",
    "trial run",
)

# Product line: name, family, filling line (1-4), acidified, allergens, shelf life days.
PRODUCT_LINES = (
    ("Smoky Chipotle BBQ Sauce", "BBQ", 1, True, "", 540),
    ("Honey Garlic BBQ Sauce", "BBQ", 3, True, "", 540),
    ("Kansas City Style BBQ Sauce", "BBQ", 1, True, "", 540),
    ("Carolina Gold BBQ Sauce", "BBQ", 2, True, "Mustard", 450),
    ("Classic Tomato Ketchup", "Ketchup and tomato", 2, True, "", 365),
    ("Fancy Ketchup", "Ketchup and tomato", 3, True, "", 365),
    ("Pizza Sauce", "Ketchup and tomato", 3, True, "", 365),
    ("Marinara Sauce", "Ketchup and tomato", 1, True, "", 540),
    ("Medium Chunky Salsa", "Salsa", 1, True, "", 450),
    ("Salsa Verde", "Salsa", 1, True, "", 450),
    ("Roasted Corn Salsa", "Salsa", 1, True, "", 365),
    ("Yellow Mustard", "Mustard and dressing", 2, True, "Mustard", 540),
    ("Spicy Brown Mustard", "Mustard and dressing", 2, True, "Mustard", 540),
    ("Honey Mustard Dressing", "Mustard and dressing", 2, True, "Egg, mustard", 270),
    ("Sesame Ginger Dressing", "Mustard and dressing", 2, True, "Sesame, soy, wheat", 270),
    ("Ranch Dressing", "Mustard and dressing", 3, True, "Milk, egg", 240),
    ("Buffalo Wing Sauce", "Hot and wing", 3, True, "", 540),
    ("Chili Garlic Sauce", "Hot and wing", 1, True, "", 540),
    ("Habanero Hot Sauce", "Hot and wing", 2, True, "", 720),
    ("Sweet Pickle Relish", "Relish", 1, True, "", 450),
    ("Hot Dog Relish", "Relish", 1, True, "Mustard", 450),
    ("Garlic Herb Seasoning", "Dry seasoning", 4, False, "", 730),
    ("Taco Seasoning", "Dry seasoning", 4, False, "", 730),
    ("BBQ Dry Rub", "Dry seasoning", 4, False, "", 730),
    ("Lemon Pepper Seasoning", "Dry seasoning", 4, False, "", 730),
    ("Steakhouse Sauce", "BBQ", 1, True, "Soy, wheat, fish", 540),
    ("Sweet Chili Sauce", "Hot and wing", 2, True, "", 540),
    ("Tartar Sauce", "Mustard and dressing", 3, True, "Egg", 240),
    ("Cocktail Sauce", "Ketchup and tomato", 1, True, "", 450),
    ("Jalapeno Relish", "Relish", 1, True, "", 450),
)
# Pack variants: pack size, units per case, list price per case (round prices are common).
SAUCE_PACKS = (
    ("18 oz glass jar", 12, 30.0), ("20 oz squeeze bottle", 12, 25.0),
    ("1 gal jug", 4, 45.0), ("1.5 kg pouch", 6, 38.75), ("12 oz glass jar", 12, 27.4),
    ("40 oz squeeze bottle", 8, 34.6),
)  # fmt: skip
DRY_PACKS = (
    ("2.5 oz pouch", 24, 31.2), ("25 lb bag", 1, 60.0), ("6 oz shaker", 12, 35.0),
    ("5 lb bag", 4, 52.9), ("1 oz pouch", 48, 28.8), ("12 oz shaker", 6, 29.5),
)  # fmt: skip

# Material: description, type, unit, contract price per unit, allergen, lead time days.
MATERIALS = (
    ("Distilled white vinegar 120 grain, bulk", "Ingredient", "L", 0.46, "None", 5),
    ("Cane sugar, 50 lb bag", "Ingredient", "kg", 1.12, "None", 7),
    ("Tomato paste 31% NTSS, 300 gal aseptic tote", "Ingredient", "tote", 1_500.0, "None", 21),
    ("Corn syrup 42 DE, bulk", "Ingredient", "kg", 0.71, "None", 7),
    ("Fine flake salt", "Ingredient", "kg", 0.38, "None", 7),
    ("Xanthan gum 80 mesh", "Ingredient", "kg", 9.85, "None", 14),
    ("Modified corn starch", "Ingredient", "kg", 2.15, "None", 10),
    ("Chipotle pepper puree", "Ingredient", "kg", 6.4, "None", 21),
    ("Dehydrated minced onion", "Ingredient", "kg", 4.75, "None", 14),
    ("Granulated garlic", "Ingredient", "kg", 6.9, "None", 14),
    ("Mustard flour", "Ingredient", "kg", 3.6, "Mustard", 14),
    ("Salted egg yolk", "Ingredient", "kg", 5.25, "Egg", 7),
    ("Soy sauce, brewed", "Ingredient", "L", 2.8, "Soy", 14),
    ("Toasted sesame seeds", "Ingredient", "kg", 5.0, "Sesame", 14),
    ("Natural smoke flavor", "Ingredient", "kg", 25.0, "None", 21),
    ("Honey, grade A", "Ingredient", "kg", 4.3, "None", 14),
    ("Brown sugar, light", "Ingredient", "kg", 1.35, "None", 7),
    ("Molasses", "Ingredient", "kg", 1.05, "None", 10),
    ("Ground black pepper", "Ingredient", "kg", 8.1, "None", 14),
    ("Paprika, smoked", "Ingredient", "kg", 7.6, "None", 21),
    ("Diced jalapenos, brined", "Ingredient", "kg", 2.4, "None", 14),
    ("Tomatillo puree", "Ingredient", "kg", 2.95, "None", 21),
    ("Cucumber relish stock", "Ingredient", "kg", 1.6, "None", 21),
    ("Buttermilk powder", "Ingredient", "kg", 4.8, "Milk", 14),
    ("Lemon juice concentrate", "Ingredient", "L", 3.2, "None", 10),
    ("18 oz glass jar, 70 mm lug finish", "Packaging, primary", "ea", 0.31, "None", 28),
    ("70 mm lug cap, plastisol liner", "Packaging, primary", "ea", 0.06, "None", 28),
    ("20 oz PET squeeze bottle", "Packaging, primary", "ea", 0.19, "None", 21),
    ("38 mm flip-top closure", "Packaging, primary", "ea", 0.04, "None", 21),
    ("1 gal HDPE jug", "Packaging, primary", "ea", 0.55, "None", 21),
    ("1.5 kg spouted pouch", "Packaging, primary", "ea", 0.28, "None", 35),
    ("Pressure-sensitive front label", "Packaging, primary", "roll", 150.0, "None", 21),
    ("Back label with nutrition panel", "Packaging, primary", "roll", 140.0, "None", 21),
    ("2.5 oz seasoning pouch", "Packaging, primary", "ea", 0.05, "None", 28),
    ("6 oz shaker with sifter cap", "Packaging, primary", "ea", 0.22, "None", 28),
    ("12-count RSC case", "Packaging, secondary", "ea", 0.48, "None", 14),
    ("4-count jug case", "Packaging, secondary", "ea", 0.62, "None", 14),
    ("Stretch film, 80 gauge", "Packaging, secondary", "roll", 25.0, "None", 7),
    ("GMA pallet, grade A", "Packaging, secondary", "ea", 15.0, "None", 7),
    ("Corner board, 48 inch", "Packaging, secondary", "case", 45.0, "None", 7),
    ("Case label, thermal transfer", "Packaging, secondary", "roll", 35.0, "None", 7),
    ("Food-grade H1 gear oil", "MRO", "L", 18.5, "None", 7),
    ("Filler valve seal kit", "MRO", "ea", 250.0, "None", 21),
    ("Capper chuck insert", "MRO", "ea", 85.0, "None", 21),
    ("Conveyor chain, 12 ft", "MRO", "ea", 350.0, "None", 14),
    ("Photo-eye sensor", "MRO", "ea", 120.0, "None", 10),
    ("Inkjet coder ink cartridge", "MRO", "ea", 65.0, "None", 7),
    ("Metal detector test wand set", "MRO", "ea", 150.0, "None", 14),
    ("Kettle agitator scraper blade", "MRO", "ea", 200.0, "None", 28),
    ("CIP chlorinated alkaline cleaner", "MRO", "L", 3.4, "None", 7),
    ("Sanitizer, peracetic acid", "MRO", "L", 4.15, "None", 7),
    ("ATP swab", "MRO", "case", 300.0, "None", 10),
)
# Second and later items of one kind, as an item master grows (index past the base list).
MATERIAL_VARIANTS = {
    "Ingredient": ("", ", organic", ", non-GMO", ", kosher certified", ", second source",
                   ", fine grind", ", coarse", ", bulk tote"),
    "Packaging, primary": ("", ", private label print", ", second source", ", clear",
                           ", amber", ", tamper band", ", recycled content", ", foodservice"),
    "Packaging, secondary": ("", ", private label print", ", heavy duty", ", second source",
                             ", club pack", ", display ready", ", kraft", ", export"),
    "MRO": ("", ", spare", ", L2 size", ", L3 size", ", second source", ", stainless",
            ", rebuild kit", ", heavy duty"),
}  # fmt: skip

SUPPLIER_PLACES = (
    "Valley", "Great Lakes", "Heartland", "Prairie", "Riverside", "Northstar", "Bluestem",
    "Cedar Ridge", "Ironwood", "Sunfield", "Granite City", "Lakeview", "Westbrook", "Tri-State",
    "Mill Creek", "Oak Harbor", "Redbud", "Summit", "Pioneer", "Clearwater",
)  # fmt: skip
SUPPLIER_NOUNS = {
    "Ingredient": ("Paste", "Spice Mills", "Sweeteners", "Vinegar Works", "Ingredients",
                   "Pepper Farms"),
    "Packaging": ("Glass Container", "Closures", "Label and Print", "Corrugated Box",
                  "Flexible Packaging", "Bottle Supply"),
    "MRO": ("Industrial Supply", "Bearing and Drive", "Process Equipment", "Sanitation Supply",
            "Controls"),
    "Service": ("Pest Control", "Calibration Services", "Laboratory", "Uniform Service",
                "Waste Services"),
}  # fmt: skip
SUPPLIER_SUFFIXES = ("Inc.", "Company", "LLC", "Corporation", "Co.")
SUPPLIER_COUNTRIES = ("United States", "United States", "United States", "Mexico", "Canada",
                      "United States", "Italy", "United States")  # fmt: skip
CERTIFICATIONS = ("SQF Food Safety, Level 2", "BRCGS Food Safety, grade AA",
                  "FSSC 22000", "SQF Food Safety, Level 2", "BRCGS Packaging Materials",
                  "ISO 9001")  # fmt: skip

CUSTOMER_PLACES = (
    "Prairie", "Lakeshore", "Riverbend", "Heartland", "Northgate", "Cedar Valley", "Bluff City",
    "Twin Rivers", "Maple Grove", "Sandhill", "Fox River", "Copper Hill", "Kettle Moraine",
    "Bayfield", "Stonebridge", "Harvest Moon", "Oakmont", "Silver Lake", "Gateway", "Wildwood",
    "Elm Creek", "Sunrise", "Badger State", "Lincolnway",
)  # fmt: skip
CUSTOMER_NOUNS = {
    "Retail": ("Fresh Markets", "Food Stores", "Supermarkets", "Grocery Co.", "Market Basket",
               "Family Foods", "Super Center", "Neighborhood Markets", "Fresh Fare", "Food Hall"),
    "Foodservice": ("Foodservice Supply", "Restaurant Supply", "Food Distributors",
                    "Institutional Foods", "Culinary Supply", "Chef Supply", "Menu Partners",
                    "Catering Supply", "Campus Dining", "Grill Supply"),
    "Wholesale": ("Grocers Cooperative", "Wholesale Grocers", "Distributing Co.",
                  "Trading Company", "Merchandise Group", "Cash and Carry", "Supply Company",
                  "Wholesale Foods", "Brokerage", "Provisions"),
    "Private label": ("Brands", "Pantry Brands", "Kitchen Brands", "Select Foods",
                      "Signature Foods", "Own Brand Group", "Table Brands", "Market Brands",
                      "Heritage Foods", "Craft Foods"),
    "Co-man": ("Co-Packers", "Contract Foods", "Food Partners", "Kitchen Works",
               "Food Ventures", "Sauce Works", "Packing Co.", "Food Labs", "Batch Co.",
               "Foods Group"),
}  # fmt: skip
REGIONS = ("Chicago metro", "Milwaukee and eastern Wisconsin", "Twin Cities", "Iowa and Nebraska",
           "Indiana", "Michigan", "Ohio valley", "St. Louis and Missouri", "Kansas City",
           "Dakotas")  # fmt: skip
AREA_CODES = ("312", "414", "612", "515", "317", "616", "513", "314", "816", "608")

CARRIERS = ("Midland Freight Lines", "Lakeway Transport", "Ridgeline Logistics",
            "Customer pickup", "Northern Star Carriers", "Blue Prairie Trucking")  # fmt: skip
LOCATIONS = ("Cooler 1", "Dry storage, aisle A", "Dry storage, aisle B", "Tote yard",
             "Packaging mezzanine", "MRO cage")  # fmt: skip
FG_LOCATIONS = ("FG warehouse, bay 1", "FG warehouse, bay 2", "FG warehouse, bay 3",
                "Hold cage", "Staging lane 4")  # fmt: skip

# Equipment by work center type: name, tag code, model, criticality.
LINE_EQUIPMENT = (
    ("Rotary filler", "FIL", "Fillworth RF-24", "A"), ("Capper", "CAP", "Torqline CX-8", "A"),
    ("Metal detector", "MD", "Ferroguard MDX 300", "A"), ("Labeler", "LAB", "Labelwise L-200", "B"),
    ("Inkjet coder", "INK", "Codejet 9450", "B"), ("Case packer", "CP", "Packwell TP-12", "B"),
    ("Checkweigher", "CW", "Weighbright CW-60", "B"),
)  # fmt: skip
KETTLE_EQUIPMENT = (
    ("Steam-jacketed kettle", "KTL", "Kettleford SJ-2000", "A"),
    ("Kettle agitator", "AGI", "Kettleford SA-40", "B"),
    ("Steam control valve", "SCV", "Steamright 3-inch", "B"),
)  # fmt: skip
UTILITY_EQUIPMENT = (
    ("Boiler", "UT-BLR", "Hearthstone 150 HP firetube", "A"),
    ("Air compressor", "UT-AIR", "Airmaker RS-75", "A"),
    ("Glycol chiller", "UT-CHL", "Coldbay 40T", "B"),
    ("Palletizer", "WH-PAL", "Stackwell P-20", "B"),
    ("Forklift", "WH-FL", "Hoistline 5000", "C"),
    ("Stretch wrapper", "WH-SW", "Wrapwell 2100", "C"),
    ("CIP skid", "UT-CIP", "Cleanflow 3-tank", "B"),
    ("Water softener", "UT-WS", "Softwell 210", "C"),
)

PM_TASKS = (
    "{tag}: inspect valves, lube cam track", "{tag}: replace wear parts per PM route",
    "{tag}: check belts, chains and guards", "{tag}: calibrate sensors and photo-eyes",
    "{tag}: grease bearings, check alignment", "{tag}: weekly PM route",
)  # fmt: skip
CORRECTIVE_TASKS = {
    3: "Capper chuck slipping, torque low, replace chuck insert",
    5: "Inkjet coder not printing, clean head and replace ink",
    7: "Line starved waiting on batch, check kettle steam supply",
    8: "No packaging at the filler, check the glass depalletizer",
    16: "Palletizer fault on the pusher, reset and inspect",
    17: "Power dip tripped the line, check the drive and restart",
}
