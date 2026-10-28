"""Invented names and short clinic phrases used by the Clinic pack (US outpatient care)."""

from __future__ import annotations


def _words(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split("|"))


# Real uses of the marker words in clinic work (plan rule 10).
TRADE_PHRASES = (
    "rapid test",
    "lab test",
    "test result",
    "sample collection",
    "pregnancy test",
    "send-out test",
)

FIRST_NAMES = _words(
    "Marisol|Kieran|Aiyana|Tomasz|Liza|Oren|Priya|Benedikt|Noemi|Dario|Yuki|Celeste"
    "|Rafael|Hattie|Joaquin|Imani|Gavin|Lorena|Theo|Delphine|Malik|Rosalind|Eamon|Sasha"
    "|Wendell|Anika|Bruno|Clara|Desmond|Esther|Felix|Gloria|Hector|Iris|Jonah|Keiko"
    "|Luther|Mireille|Nolan|Odessa|Pablo|Quincy|Ruth|Silas|Talia|Ulises|Vera|Wesley"
)
LAST_NAMES = _words(
    "Dantes|Holloway|Brooks|Wren|Macaraeg|Castell|Venkat|Sorell|Arceo|Pellham|Tanabe"
    "|Omondi|Ibarrola|Lindqvist|Sevilla|Achterberg|Blakely|Corrigan|Dunmore|Esposito"
    "|Fairweather|Galloway|Hargrove|Ingersoll|Jaramillo|Kettering|Lachance|Montoya"
    "|Nakashima|Oyelaran|Prentiss|Quintero|Rasmussen|Stroud|Thibodeaux|Underhill"
    "|Valdivia|Whitcombe|Yarbrough|Zielinski|Abernathy|Beaumont|Cardenas|Delacroix"
    "|Eriksen|Fontaine|Gutierrez|Halvorsen"
)
CITIES = _words(
    "Lakeshore|Riverton|Maple Heights|Cedar Falls|Brookhaven|Fairview|Oak Park West"
    "|Millbrook|Ashford|Kingsley"
)
STAFF_NAMES = _words(
    "Dr. Helena Brandt|Dr. Samuel Achebe|Dr. Aurelia Vance|Dr. Martin Okoye"
    "|Dr. Simone Lachapelle|Dr. Raj Bhattacharya|Dr. Colette Ambrose|Dr. Henrik Dahl"
    "|Dr. Yolanda Pierce|Dr. Ivan Petrakis|Dr. Naomi Feld|Dr. Curtis Langford"
    "|Ellen Marsh, NP|Jordan Kale, PA-C|Ruby Haddad, NP|Corinne Waller, RN|Tomas Reyna, MA"
    "|Ingrid Solberg, MLS|Jamal Whitfield, MLS|Lucia Ferraro|Nadia Kowalczyk, PharmD"
    "|Elliot Fairbanks, PharmD|Rosa Delgado, CPhT|Farah Siddiqui, RN|Abigail Shaw, RN"
    "|Leon Barrett, RN|Mei Lin Okada, RN|Grace Ndiaye, RN|Hugo Sandoval, MA|Pia Larsen, MA"
)

PAYERS = (
    ("Lakeshore Health Plan", "Commercial insurer", "LKH01"),
    ("Prairie Mutual Insurance Co.", "Commercial insurer", "PRM22"),
    ("Medicare Part B", "Medicare", "MCRB8"),
    ("Riverbend Medicaid Partners", "Medicaid managed care", "RBM40"),
    ("Northgate HMO", "HMO", "NGH17"),
    ("Cedar Valley Employers Trust", "Employer account", "CVE05"),
    ("Summit Senior Advantage", "HMO", "SSA31"),
    ("Bluewater Benefits Group", "Commercial insurer", "BWB12"),
    ("Heartland Care Network", "Commercial insurer", "HCN09"),
    ("Oak Hollow Insurance Corporation", "Commercial insurer", "OHI27"),
    ("Fairmont Health Alliance", "HMO", "FHA14"),
    ("Kingsley School District Benefits", "Employer account", "KSD03"),
)
PLAN_SUFFIXES = _words("PPO|HMO Select|Choice Plus|Basic|Gold|Silver|Advantage")

# Chief complaint, ICD-10-CM code, and whether flu season raises it.
COMPLAINTS = (
    ("Cough and cold x3 days", "J06.9", True),
    ("Sore throat", "J02.9", True),
    ("Fever with body aches", "J11.1", True),
    ("BP follow-up", "I10", False),
    ("Diabetes follow-up", "E11.9", False),
    ("Cholesterol review", "E78.5", False),
    ("Burning on urination", "N39.0", False),
    ("Epigastric pain", "K29.70", False),
    ("Low back pain", "M54.50", False),
    ("Headache", "R51.9", False),
    ("Itchy rash", "L30.9", False),
    ("Red eye", "H10.9", False),
    ("Loose stools", "A09", False),
    ("Wheezing", "J45.909", True),
    ("Annual physical", "Z00.00", False),
    ("Flu shot", "Z23", True),
    ("Ear pain", "H92.09", True),
    ("Sinus pressure", "J01.90", True),
)
CPT_FOR_LAB = {"CBC with platelet count": "85025", "Lipid profile": "80061",
               "HbA1c": "83036", "Basic metabolic panel": "80048", "Urinalysis": "81003",
               "Influenza A/B rapid antigen": "87804", "Rapid strep antigen": "87880",
               "TSH": "84443", "Urine pregnancy test": "81025"}  # fmt: skip
# Lab service, analyte, units, reference range, specimen type.
LAB_MENU = (
    ("CBC with platelet count", "Hemoglobin", "g/dL", "12.0–15.5", "Whole blood (EDTA)"),
    ("Basic metabolic panel", "Potassium", "mmol/L", "3.5–5.1", "Serum"),
    ("Lipid profile", "LDL cholesterol", "mg/dL", "<100", "Serum"),
    ("HbA1c", "HbA1c", "%", "4.0–5.6", "Whole blood (EDTA)"),
    ("Urinalysis", "Leukocyte esterase", "", "Negative", "Urine"),
    ("Fasting blood glucose", "Glucose", "mg/dL", "70–99", "Plasma"),
    ("Creatinine", "Creatinine", "mg/dL", "0.6–1.2", "Serum"),
    ("TSH", "TSH", "mIU/L", "0.4–4.0", "Serum"),
    ("ALT", "ALT", "U/L", "7–56", "Serum"),
    ("Influenza A/B rapid antigen", "Influenza A/B antigen", "", "Not detected",
     "Nasopharyngeal swab"),
    ("Rapid strep antigen", "Group A strep antigen", "", "Not detected", "Throat swab"),
    ("Urine pregnancy test", "hCG", "", "Negative", "Urine"),
    ("Uric acid", "Uric acid", "mg/dL", "3.5–7.2", "Serum"),
    ("Stool occult blood", "Occult blood", "", "Negative", "Stool"),
)  # fmt: skip
IMAGING = _words("Chest X-ray, 2 views|Lumbar spine X-ray|Abdominal ultrasound|Ankle X-ray")
PROCEDURES = _words("Ear irrigation|Skin tag removal|Wart cryotherapy|Joint injection")
QC_ANALYTES = _words("Glucose|Potassium|Hemoglobin|HbA1c|Creatinine|ALT")

# Generic name, strength, form, cold chain.
MEDICATIONS = (
    ("Amlodipine", "5 mg", "Tablet", False), ("Losartan", "50 mg", "Tablet", False),
    ("Hydrochlorothiazide", "25 mg", "Tablet", False), ("Metoprolol", "50 mg", "Tablet", False),
    ("Metformin", "500 mg", "Tablet", False), ("Glipizide", "5 mg", "Tablet", False),
    ("Atorvastatin", "20 mg", "Tablet", False), ("Amoxicillin", "500 mg", "Capsule", False),
    ("Amoxicillin-clavulanate", "875 mg", "Tablet", False),
    ("Azithromycin", "250 mg", "Tablet", False), ("Cephalexin", "500 mg", "Capsule", False),
    ("Nitrofurantoin", "100 mg", "Capsule", False), ("Acetaminophen", "500 mg", "Tablet", False),
    ("Ibuprofen", "400 mg", "Tablet", False), ("Cetirizine", "10 mg", "Tablet", False),
    ("Albuterol", "90 mcg", "Inhaler", False), ("Omeprazole", "20 mg", "Capsule", False),
    ("Oral rehydration salts", "1 sachet", "Sachet", False),
    ("Mupirocin", "2%", "Cream or ointment", False),
    ("Influenza vaccine", "0.5 mL", "Prefilled syringe", True),
    ("Amoxicillin", "250 mg/5 mL", "Suspension", False), ("Prednisone", "10 mg", "Tablet", False),
    ("Fluticasone", "50 mcg", "Inhaler", False), ("Levothyroxine", "50 mcg", "Tablet", False),
    ("Sertraline", "50 mg", "Tablet", False), ("Tdap vaccine", "0.5 mL", "Injection", True),
)  # fmt: skip
SUPPLY_ITEMS = _words(
    "Nitrile gloves M (box of 100)|3 mL syringe with 23G needle|EDTA tube 3 mL lavender"
    "|Serum separator tube 5 mL gold|Sterile urine cup|Alcohol prep pads|Gauze 4x4"
    "|Surgical masks (box of 50)|N95 respirators|Sharps container 5 L|Glucose meter strips"
    "|HbA1c cartridges|ECG electrodes|Exam table paper roll|Hand rub 500 mL"
    "|Disinfectant wipes|Tongue depressors|Biohazard specimen bags|Specimen barcode labels"
)
SUPPLIERS = _words(
    "Lakeview Medical Supply Co.|Prairie Lab Reagents Inc.|Great Rivers Pharma Distributors"
    "|Northstar Biomedical Services|Cedar Point Office Supply|Midland Surgical Products"
    "|Harborview Diagnostics Inc.|Westfield Cold Chain Logistics|Keystone Pharmacy Wholesale"
    "|Bright Path Medical Linens|Fieldstone Clinical Supplies|Ridgeway Calibration Services"
)
SUPPLIER_DOMAINS = _words(
    "lakeview-supply|prairie-reagents|greatrivers-pharma|northstar-biomed|cedarpoint-office"
    "|midland-surgical|harborview-dx|westfield-coldchain|keystone-rx|brightpath-linens"
    "|fieldstone-clinical|ridgeway-cal"
)
EQUIPMENT = (
    ("Chemistry analyzer", "Laboratory, bench 1", "Corvane CX-310"),
    ("Hematology analyzer", "Laboratory, bench 2", "Hemalyte H5"),
    ("ECG machine", "Procedure room", "CardioTrace 12"),
    ("Autoclave", "Sterilization room", "SteriCore 23L"),
    ("Exam room BP monitor", "Exam room", "VitaCheck BP200"),
    ("Pulse oximeter", "Triage", "OxiSense P3"),
    ("Defibrillator", "Nurses' station", "LifeGuard AED"),
    ("Centrifuge", "Laboratory", "SpinLine C12"),
    ("Exam table", "Exam room", "ComfortLine 400"),
    ("Spirometer", "Procedure room", "AirMeasure S2"),
    ("Microscope", "Laboratory", "ClearView M40"),
    ("Otoscope set", "Exam room", "AuraScope Kit"),
)  # fmt: skip
FRIDGE_MODEL = "PolarSafe VR-48"

INCIDENTS = (
    ("Patient slipped on a wet floor in the waiting area", "Patient accident", "Mild"),
    ("Specimen tube arrived without a label", "Documentation", "No harm"),
    ("Wrong strength picked, caught at the counter", "Medication", "Near miss"),
    ("Needlestick while recapping a needle", "Staff injury", "Mild"),
    ("Lab result filed to the wrong chart", "Documentation", "No harm"),
    ("Referral letter emailed to the wrong address", "Privacy breach", "No harm"),
    ("Patient shouted at the cashier", "Behavior", "No harm"),
    ("BP monitor showed an error during triage", "Medical device", "No harm"),
    ("Expired lot found on the dispensary shelf", "Medication", "Near miss"),
    ("Hand-rub dispenser empty in exam room 4", "Healthcare-associated infection", "No harm"),
    ("Patient left without being seen after a 90-minute wait", "Clinical administration",
     "No harm"),
    ("Ceiling leak above the lab sink after heavy rain", "Infrastructure", "No harm"),
)  # fmt: skip
INCIDENT_LOCATIONS = _words(
    "Waiting area|Front desk|Exam room 2|Exam room 4|Laboratory|Dispensary|Triage"
    "|Procedure room|Hallway by restrooms|Parking lot entrance"
)

ENCOUNTER_NOTES = _words(
    "Seen by provider; follow-up booked in 4 weeks.|Labs ordered; patient to return fasting."
    "|Referred to ENT, routine.|Refilled maintenance meds x30d.|Pt seen, discharged home."
    "|BP rechecked at end of visit; f/u 4 wks.|Results reviewed with patient by phone."
    "|Sent to ED by ambulance; family notified.|Vaccine given, VIS provided."
    "|Interpreter used for the visit (Spanish)."
)
APPOINTMENT_NOTES = _words(
    "Pt NS x2, SMS sent.|Confirmed by phone the day before.|Rescheduled at patient request."
    "|Left voicemail, no callback yet.|Needs interpreter (Vietnamese).|Bring insurance card."
    "|Prefers afternoon slots.|Ride arranged through the county program."
)
LAB_NOTES = _words(
    "Hemolyzed, recollect requested.|Called pt re: critical K+, advised ED. Documented."
    "|Courier pickup at 15:30.|Repeat run matched within limits.|Send-out test to reference lab."
    "|Result phoned to Dr. on call.|Delta check reviewed by second MT."
)
PHARMACY_NOTES = _words(
    "Picked from the lot that expires first.|Awaiting pickup; text sent.|Prior auth pending."
    "|Substituted generic per prescriber.|Counselled on storage, pt verbalized understanding."
    "|Partial fill, balance ordered."
)
REVENUE_NOTES = _words(
    "Claim returned: missing referral number. Refiled.|Denied CO-197, auth requested from payer."
    "|Secondary claim sent after primary EOB.|Posted from the weekly ERA batch."
    "|Patient set up on a payment plan.|Coordination of benefits letter mailed."
)
OPERATIONS_NOTES = _words(
    "Vendor confirmed delivery for Thursday.|Backordered; substitute approved by pharmacy."
    "|Annual PM done, sticker updated.|Quote attached to the request."
    "|Received in good condition, lot numbers logged.|Parts on order from the manufacturer."
)
QUALITY_NOTES = _words(
    "Reviewed at the monthly quality committee.|Staff reminded at Monday huddle."
    "|Primary source verified online.|Renewal reminder emailed to the clinician."
    "|Action plan agreed with the department lead."
)
