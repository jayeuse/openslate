"""Invented UK school names and phrases used by the School pack."""

from __future__ import annotations


def _words(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split("|"))


TRADE_PHRASES = (
    "unit test",
    "periodical test",
    "end-of-term test",
    "test paper",
    "pre-test",
    "entrance test",
    "sample essay",
)

FIRST_NAMES = _words(
    "Amelia|Oliver|Isla|George|Maya|Arthur|Freya|Leo|Aisha|Harry|Grace|Noah|Zara|Theo"
    "|Ruby|Oscar|Imogen|Ethan|Florence|Jacob|Nadia|Alfie|Holly|Finley|Sofia|Edward"
    "|Lily|Adam|Esme|Charlie|Priya|Samuel|Martha|Louis|Leila|Daniel|Evelyn|Jack"
    "|Poppy|Max|Anaya|William|Rosie|Hugo|Ivy|Lucas|Amara|Joseph"
)
LAST_NAMES = _words(
    "Bennett|Clarke|Patel|Morgan|Hughes|Shah|Taylor|Khan|Lewis|Reed|Ali|Foster"
    "|Campbell|Green|Davies|Brooks|Wilson|Ahmed|Ward|Price|Murphy|Wood|Thompson"
    "|Baker|Evans|Hall|Roberts|Cook|Bailey|Cooper|Kelly|Morris|Turner|Phillips"
    "|Richardson|Mitchell|Parker|Collins|Stewart|Watson|Griffiths|James|Hunt|Gray"
    "|Sullivan|Marshall|Carter|Ellis|Hamilton|Simpson|Dixon|Fletcher|Webb|Knight"
)

FORM_NAMES = _words("Ash|Beech|Cedar|Elm|Rowan|Willow|Birch|Hazel|Maple|Oak|Pine|Sycamore")
BUILDINGS = _words("Lower School|Middle School|Upper School|Arts Block|Sports Centre")
ROOM_CODES = tuple(
    f"{building[:2].upper()}-{number:03d}"
    for building in ("Lower", "Middle", "Upper", "Arts", "Sports")
    for number in range(1, 15)
)
SUBJECTS = _words(
    "English|Mathematics|Biology|Chemistry|Physics|History|Geography|French|Spanish"
    "|Religious education|Physical education|Art|Music|Computing|Classical studies"
)
COURSE_CODES = _words("ENG|MAT|BIO|CHE|PHY|HIS|GEO|FRE|SPA|RE|PE|ART|MUS|COM|CLS")
ASSESSMENT_TITLES = _words(
    "Source analysis|Practical write-up|Independent reading response|Fieldwork report"
    "|Algebra application|End-of-term test|Poetry comparison|Laboratory investigation"
    "|Design portfolio|Oral presentation|Revision paper|Research essay"
)
ATTENDANCE_NOTES = _words(
    "Parent rang before registration; pupil expected after lunch|"
    "Medical appointment; note received|Bus delayed after road closure|Fever reported by carer|"
    "Family bereavement; pastoral team informed|"
    "Reason not yet established; office will contact home|"
    "Religious observance confirmed|"
    "Pupil arrived after the register closed|School visit list confirmed attendance"
)
INCIDENT_NOTES = _words(
    "Staff separated both pupils and recorded accounts before afternoon registration"
    "|Pastoral lead spoke with the pupil and agreed a check-in next week"
    "|Duty staff found writing on the changing-room wall after lunch"
    "|Form tutor reported repeated interruptions during independent work"
    "|Family contacted after the year-group meeting; reply is expected tomorrow"
)
HEALTH_NOTES = _words(
    "Pupil rested in the medical room and returned to the next lesson"
    "|Carer collected the pupil from reception shortly after midday"
    "|School nurse checked the care plan and recorded the visit for follow-up"
    "|Cold pack applied; pupil returned to class with advice to report any change"
)
MAINTENANCE_NOTES = _words(
    "Heating is intermittent in the east classroom; caretaker notified"
    "|Tap continues to drip in the first-floor washroom"
    "|Projector loses signal during the afternoon lesson"
    "|Loose stair edging reported near the library entrance"
    "|Fire door does not latch on the sports-centre corridor"
    "|Several chair feet need replacement before the next lesson"
)
GUARDIAN_NOTES = _words(
    "Carer asked for a call after work; tutor will try again tomorrow"
    "|Parent confirmed the appointment and will send the note this afternoon"
    "|Family meeting booked with the year lead for Thursday"
    "|Follow-up email sent with the agreed attendance plan"
)
FEE_ITEMS = _words(
    "Autumn tuition|Spring tuition|Summer tuition|Registration charge|Laboratory materials"
    "|Learning resources|School bus term pass|Residential visit|Music tuition"
    "|Sports kit|Acceptance deposit|Re-enrolment deposit|Graduation costs"
)
LEAVE_REASONS = _words(
    "Seasonal illness|Medical appointment|Family care|Professional learning"
    "|Bereavement leave|Annual leave|Childcare emergency"
)
INCIDENT_BEHAVIOURS = _words(
    "Persistent disruption|Verbal abuse|Physical assault|Bullying|"
    "Racist or disability-related abuse|Property damage|Theft|Vaping|"
    "Phone use during an examination|Cheating or plagiarism|Uniform violation|Truancy|"
    "Repeated lateness|Leaving site without permission"
)
