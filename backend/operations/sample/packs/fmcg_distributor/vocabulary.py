# ruff: noqa: E501 -- vocabulary rows are kept whole for review.
"""Invented names and short trade phrases for a Philippine FMCG distributor (research §9)."""

from __future__ import annotations


def _words(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split("|"))


# Real uses of the marker words in distribution work (plan rule 10).
TRADE_PHRASES = ("free samples",)

# Name, code, category, GS1 company prefix, payment terms. All principals are invented.
PRINCIPALS = (
    ("Kestrel Dairy Corp.", "KST", "Dairy", "4806721", "45 days"),
    ("Linaw Home Care Inc.", "LNW", "Home care", "4806733", "30 days"),
    ("Palmera Personal Care", "PLM", "Personal care", "4806745", "60 days"),
    ("Tala Snack Foods", "TLA", "Packaged food", "4806758", "30 days"),
    ("Brightbay Beverages", "BRB", "Beverages", "4806762", "45 days"),
    ("Sabaw Foods Mfg.", "SBW", "Packaged food", "4806774", "30 days"),
    ("Northfield Canned Goods", "NFC", "Packaged food", "4806786", "45 days"),
    ("Verdant Health OTC", "VHO", "OTC and health", "4806791", "60 days"),
    ("Aquapura Waters Inc.", "AQP", "Beverages", "4806803", "30 days"),
    ("Krunchi Snacks Corporation", "KRN", "Packaged food", "4806815", "30 days"),
    ("Isla Condiments Corp.", "ISL", "Packaged food", "4806827", "45 days"),
    ("Kawayan Tissue Products", "KWY", "Home care", "4806839", "30 days"),
)
REGIONS = ("Visayas", "Mindanao", "North Luzon")
ACCOUNT_MANAGERS = _words(
    "Aileen Castro|Ronaldo Uy|Jennifer Sy|Michael Ong|Liezl Panganiban|Raymond Tiu"
    "|Cherry Mae Lopez|Francis Go|Abigail Yap|Noel Villafuerte|Sheila Tan|Gerald Chua"
)

# Item, pieces per case, shelf life in days, ABC class. Brand comes from the principal.
SKUS: dict[str, tuple[tuple[str, int, int, str], ...]] = {
    "KST": (("Evaporated Filled Milk 370ml", 48, 540, "A"), ("Choco Milk Drink 180ml", 24, 270, "A"),
            ("Condensada 300ml", 48, 540, "B"), ("Powdered Milk 33g sachet", 144, 365, "A"),
            ("Full Cream Milk 1L", 12, 270, "C"), ("Kesong Puti Spread 100g", 36, 120, "C")),
    "LNW": (("Dishwashing Liquid Calamansi 250ml", 24, 1_095, "A"),
            ("Powder Detergent 66g sachet", 144, 730, "A"), ("Fabric Conditioner 25ml sachet", 144, 730, "A"),
            ("Bar Detergent 380g", 36, 1_095, "B"), ("Bleach 1L", 12, 540, "B"),
            ("Toilet Bowl Cleaner 500ml", 12, 1_095, "C")),
    "PLM": (("Shampoo Sachet 12ml (12s)", 24, 1_095, "A"), ("Bath Soap 90g", 72, 1_095, "A"),
            ("Conditioner Sachet 12ml (12s)", 24, 1_095, "B"), ("Toothpaste 50ml", 72, 730, "A"),
            ("Baby Cologne 100ml", 24, 1_095, "C"), ("Petroleum Jelly 50g", 72, 1_095, "C")),
    "TLA": (("Corned Meat 150g", 48, 1_095, "A"), ("Meat Loaf 150g", 48, 1_095, "B"),
            ("Vienna Sausage 130g", 48, 1_095, "B"), ("Liver Spread 85g", 72, 730, "B"),
            ("Luncheon Meat 340g", 24, 1_095, "C")),
    "BRB": (("Cola 1.5L", 12, 270, "A"), ("Orange Juice Drink 250ml", 24, 365, "A"),
            ("Lemon Soda 330ml can", 24, 365, "B"), ("Iced Tea Powder 25g", 120, 540, "B"),
            ("Energy Drink 250ml", 24, 365, "C")),
    "SBW": (("Instant Noodles Beef 55g", 72, 270, "A"), ("Pancit Canton Kalamansi 60g", 72, 270, "A"),
            ("Instant Noodles Chicken 55g", 72, 270, "A"), ("Mami Cup Sotanghon 45g", 24, 270, "B"),
            ("Pancit Canton Sweet and Spicy 60g", 72, 270, "B")),
    "NFC": (("Sardines in Tomato Sauce 155g", 100, 1_095, "A"), ("Mackerel in Natural Oil 155g", 100, 1_095, "B"),
            ("Tuna Flakes in Oil 180g", 48, 1_095, "B"), ("Sardines Hot and Spicy 155g", 100, 1_095, "B"),
            ("Pork and Beans 230g", 48, 730, "C")),
    "VHO": (("Paracetamol 500mg (10s)", 50, 1_095, "A"), ("Ascorbic Acid 500mg (10s)", 50, 730, "A"),
            ("Loperamide 2mg (10s)", 50, 1_095, "C"), ("Antacid Chewable (10s)", 50, 730, "B"),
            ("Oral Rehydration Salts 4.1g", 100, 730, "B")),
    "AQP": (("Drinking Water 500ml", 24, 540, "A"), ("Drinking Water 1L", 12, 540, "A"),
            ("Distilled Water 6L", 2, 540, "B"), ("Alkaline Water 350ml", 24, 540, "C")),
    "KRN": (("Cheese Rings 60g", 50, 180, "A"), ("Corn Chips BBQ 100g", 40, 180, "B"),
            ("Shrimp Crackers 60g", 50, 180, "A"), ("Peanut Brittle 30g (10s)", 24, 240, "C"),
            ("Potato Sticks 25g (10s)", 24, 180, "B")),
    "ISL": (("Soy Sauce 1L", 12, 730, "A"), ("Cane Vinegar 1L", 12, 730, "A"),
            ("Fish Sauce 350ml", 24, 1_095, "B"), ("Banana Ketchup 320g", 24, 540, "A"),
            ("Oyster Sauce 156g", 48, 730, "C")),
    "KWY": (("Bathroom Tissue 2-ply (12s)", 6, 1_095, "A"), ("Table Napkin 250s", 24, 1_095, "B"),
            ("Kitchen Towel 2 rolls", 12, 1_095, "C"), ("Facial Tissue 200s", 24, 1_095, "C")),
}  # fmt: skip
PACK_VARIANTS = (
    "", "promo pack", "twin pack", "new look", "value pack", "bundle of 3", "sari-sari pack",
    "family pack", "buy 1 take 1", "with free tumbler", "limited edition", "multipack",
    "school pack", "holiday pack", "economy pack", "export label",
)

OUTLET_OWNERS = _words(
    "Aling Nena|Mang Tonyo|Aling Charing|Ate Joy|Kuya Boy|Aling Lorna|Mang Dado|Ate Weng"
    "|Tita Baby|Mang Ben|Aling Pacing|Ate Marlyn|Kuya Rene|Aling Rosing|Mang Celso|Ate Gina"
    "|Aling Fe|Mang Jun|Ate Liza|Kuya Arnold|Aling Tess|Mang Romy|Ate Rhea|Aling Myrna"
)
STORE_WORDS = {
    "Sari-sari store": ("Store", "Sari-sari Store", "Variety Store"),
    "Small grocery": ("Grocery", "Mini Grocery", "Grocery and General Merchandise"),
    "Pharmacy or drugstore": ("Pharmacy", "Drugstore", "Botika"),
    "Minimart": ("Minimart", "Mini Mart", "Convenience Store"),
    "Wholesaler or market stall": ("Trading", "Wholesale", "Market Stall"),
    "Carinderia": ("Carinderia", "Eatery", "Lutong Bahay"),
    "Supermarket (modern trade)": ("Supermarket", "Family Supermarket", "Supermart"),
}
SUPERMARKETS = _words(
    "Bayview Supermart|Golden Grain Supermarket|Masagana Supermart|Tagumpay Superstore"
    "|Liwanag Supermarket|Sampaloc Supercenter|Pag-asa Supermart|Riverside Supermarket"
)
BARANGAYS = _words(
    "San Roque|Poblacion|Santo Niño|San Isidro|Bagong Silang|Malanday|Concepcion|Santa Lucia"
    "|San Antonio|Maybunga|Bagumbayan|Tumana|Kalumpang|Dalandanan|Malinta|Marulas|Gen. T. de Leon"
    "|Ugong|Karuhatan|Lingunan|Parada|Mapulang Lupa|Punturin|Bignay"
)
CITIES = ("Valenzuela", "Malabon", "Marikina", "Caloocan", "Meycauayan", "Obando")
STREETS = _words(
    "Rizal St.|Mabini St.|Bonifacio Ave.|MacArthur Hwy.|Del Pilar St.|Luna St.|Gov. Santiago St."
    "|Kalye Onse|Purok 3|Sitio Mabuhay|Aguinaldo St.|J. P. Rizal Ave."
)
TERRITORIES = _words(
    "Valenzuela North|Valenzuela South|Malabon Poblacion|Marikina Riverside|Caloocan Bagong"
    " Silang|Meycauayan Town|Obando Coastal|Malinta to Karuhatan"
)
CONTACT_NAMES = _words(
    "Nena Villanueva|Antonio Bautista|Rosario Dela Cruz|Joy Mendoza|Boy Ramirez|Lorna Garcia"
    "|Eduardo Flores|Wilma Santos|Benjamin Cruz|Pacita Gonzales|Marlyn Reyes|Rene Aquino"
)
PROMO_MECHANICS = {
    "Free goods (buy X get Y)": "Buy 12 pieces, get 1 free (12+1) on {item}. Max 10 free pieces per outlet per visit.",
    "Off-invoice discount": "{pct}% off-invoice on {item} for sari-sari and small grocery outlets.",
    "Quantity purchase scheme": "Buy 5 cases of {item} in one order, get 1 case free. Proof: invoice copy.",
    "Value purchase scheme": "₱500 credit note for every ₱10,000 of {brand} bought in the month.",
    "Display allowance": "₱1,500 a month for a shelf strip of {brand} at eye level. Photo audit monthly.",
    "Bill-back": "Principal bills back ₱{amount} a case on {item} sold to modern trade.",
    "Listing fee": "One-time ₱{amount} listing fee for {item} in supermarket branches.",
}  # fmt: skip
VEHICLE_LETTERS = ("NBC", "NDE", "NFG", "NHK", "NJL", "NMP", "NQR", "NTV", "NWX", "NAB")

SALES_NOTES = _words(
    "Owner asked 12+1 on noodles, applied.|Store closed, will revisit Thu.|Shelf low on evap,"
    " suggested 2 cs.|Prefers delivery before 10am.|Cust promised to pay Fri, PDC dated end of"
    " month.|New chiller, asked for Brightbay display.|Competitor promo on sardines this week."
    "|Owner wants smaller pack sizes.|Collect old balance first before new order."
)
WAREHOUSE_NOTES = _words(
    "Lot near expiry, push via van routes.|BO pickup 3 cs evap, dented, see photo.|Recount done,"
    " variance confirmed, raise ADJ.|Short 2 cs on GRN, principal DR says 50, counted 48.|Moved"
    " to bin A-03 for FEFO.|Pallet wrap torn on arrival.|Repacked damaged cases into mixed case."
)
CREDIT_NOTES = _words(
    "Cust promised to pay Fri.|PDC received, deposit on due date.|Cash short ₱1,250, salesman"
    " to explain at huddle.|Statement sent, no reply yet.|Owner abroad, wife will settle.|Paid"
    " in full at counter.|Partial payment, balance next week.|Cheque bounced, account on hold."
)
ACCOUNTING_NOTES = _words(
    "Claim returned by principal — need signed outlet list.|Credit note received, offset vs"
    " payables.|Price variance ₱2.50 a case, ask principal.|Display photos attached.|Filed with"
    " complete proof of performance.|Waiting for the principal's validation."
)
LOGISTICS_NOTES = _words(
    "PMS done at 45,000 km.|Left early to beat the traffic on MacArthur Hwy.|Drop failed, store"
    " closed, re-ship tomorrow.|Flooded road at Malanday, rerouted.|Truck back at 18:30."
)
PURCHASING_NOTES = _words(
    "Principal price increase effective the 1st.|Allocation only, principal plant shutdown."
    "|Suggested order from stock cover.|Expedite, stock cover under 7 days.|New SKU listing,"
    " first order."
)
ORDER_NOTES = _words(
    "Deliver before 10am, owner goes to the market after.|Owner asked 12+1 on noodles, applied."
    "|Collect old balance first before new order.|Call before delivery, gate is locked at noon."
    "|Add 2 cs Cola 1.5L if stock allows.|Same order as last week.|Owner wants smaller pack"
    " sizes next time.|Unload at the back door, narrow street."
)
OUTLET_NOTES = _words(
    "Owner wants smaller pack sizes.|New chiller, asked for Brightbay display.|Prefers delivery"
    " before 10am.|Competitor promo on sardines this week.|Open 6am to 9pm, closed Sundays."
    "|Daughter handles the orders when the owner is away.|Narrow street, van only, no truck."
)
TOUR_NOTES = _words(
    "Sold out of Cola 1.5L by noon.|Two outlets closed, flooded road at Malanday.|Cash short"
    " ₱1,250, salesman to explain at huddle.|Brought back 3 cs evap, outlets well stocked."
    "|Checked in at 17:40, all cash remitted.|Tire changed on the way, started late."
)
GRN_NOTES = _words(
    "Short 2 cs on GRN, principal DR says 50, counted 48.|Pallet wrap torn on arrival."
    "|Truck arrived 14:30, unloaded by 16:00.|Two cases dented, kept aside for the claim."
    "|All lots and expiry dates checked against the DR."
)
LOT_NOTES = _words(
    "Lot near expiry, push via van routes.|Moved to bin A-03 for FEFO.|Repacked damaged cases"
    " into mixed case.|Keep away from the loading door, heat.|Principal recall notice, hold."
)
RETURN_NOTES = _words(
    "BO pickup 3 cs evap, dented, see photo.|Expired stock found during shelf check.|Outlet"
    " refused the wrong item at delivery.|Sachets torn, rats in the storeroom.|Swollen cans,"
    " kept apart for the principal.|Owner wants a replacement, not a credit memo."
)
COUNT_NOTES = _words(
    "Recount done, variance confirmed, raise ADJ.|Count matches the system.|Two cases found in"
    " the wrong bin.|Counted with the checker from credit.|Damaged cases counted separately."
)
FOLLOWUP_NOTES = _words(
    "Cust promised to pay Fri.|Owner abroad, wife will settle.|Statement sent, no reply yet."
    "|Will pay by PDC dated end of month.|Store closed, left a notice with the neighbor."
    "|Spoke to the daughter; owner pays Saturday.|Asked for a copy of the invoice again."
)
VARIANCE_NOTES = _words(
    "Price variance ₱2.50 a case, ask principal.|Invoice shows 2 cs more than the GRN."
    "|Old price used; principal to send a credit memo."
)

