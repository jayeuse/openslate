# ruff: noqa: E501 -- copy is kept in complete announcement rows for review.
"""Board posts, event copy, and OpenView names for a UK day school."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.school.catalog import _MODULES

POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    'company': (
        ('Autumn term dates and half-term', 'The school calendar lists term dates, half-term and inset days. Check it before arranging family travel.'),
        ('Welcome to our new colleagues', 'Please welcome the staff who joined this term. Say hello when you see them around school.'),
        ("Parents' evenings: bookings open next week", 'Form tutors will share appointment slots. Contact the school office if you need another time.'),
        ('Pupil collection arrangements', 'Tell reception before the end of the day if someone new will collect a pupil. Please bring identification.'),
        ('Fire practice on Thursday morning', 'We will practise leaving the building at 10.30. Staff will guide each form to its assembly point.'),
        ('Autumn term priorities', 'We are focusing on strong attendance, thoughtful reading and a calm start to each lesson.'),
        ('School closes for half-term on Friday', 'Lessons finish at 3.15 pm. Pupils return on Monday 2 November.'),
        ('Keep your contact details up to date', 'Please contact the school office to change telephone numbers or emergency contacts.'),
    ),
    'admissions': (
        ('Open morning places are available', 'Families can meet the admissions team and visit the classrooms on Wednesday morning.'),
        ('Applications for September entry', 'Send the completed forms and supporting documents to the admissions office by 14 November.'),
        ('Enrolment documents for new pupils', 'Return the signed forms to admissions before the induction evening.'),
        ('Year 7 transition visits', 'We will write to families with their visit time and the items pupils should bring.'),
        ('School tour appointments', 'The next tours start at 9.30 am on Tuesday and Thursday. Please book through reception.'),
        ('Sibling applications', "Please include the sibling's current year group so the admissions team can route the enquiry."),
        ('Offer letters issued this month', 'Families can confirm a place by returning the acceptance form and deposit details.'),
        ('New starter information evening', 'Join us in the main hall to hear about uniforms, lunch arrangements and the first week.'),
    ),
    'academic': (
        ('Year-group reading lists published', 'Subject leads have added the autumn reading lists for each year group.'),
        ('Termly assessment dates confirmed', 'Check the department calendar for assessment dates and the time allowed for each paper.'),
        ('Form tutor notes due on Friday', 'Please complete the progress notes before the review meeting next week.'),
        ('Rotating timetable begins after half-term', 'The revised timetable is available from the academic office. Check room changes before Monday.'),
        ('Practical work safety briefing', 'Science staff will review the room routines with each class before practical lessons begin.'),
        ('School reports are being checked', 'Form tutors should confirm subject entries before the registrar prepares each batch.'),
        ('Course choices for next year', 'Pupils will receive the subject guide during form time. Questions can go to the year lead.'),
        ('Marking guidance updated', 'The academic office has shared the current marking guidance with all subject leads.'),
    ),
    'student_affairs': (
        ('After-school clubs begin next Monday', 'The activity list and meeting rooms are posted by reception. Pupils can speak to their form tutor.'),
        ("Parents' evening appointments are open", 'Families can book a time with the form tutor and subject staff through the school office.'),
        ('House activities this half-term', 'House leads will share the lunchtime schedule with each form this week.'),
        ('Uniform guidance for colder weather', 'Please check the uniform guide before adding extra layers to the school uniform.'),
        ('Year 12 careers talk', 'Visitors will speak about apprenticeships, university courses and local opportunities.'),
        ('Volunteer rota for the winter concert', 'Staff can add their name to the event rota through the activities coordinator.'),
        ('Pastoral drop-in times', 'The pastoral team is available during lunch on Tuesday and Thursday in the pastoral office.'),
        ('Positive behaviour guidance', 'Form tutors can use the updated behaviour framework in their year-group meetings.'),
    ),
    'health': (
        ('Medicine consent forms due Friday', 'Send completed forms directly to the school nurse. Keep personal health details off shared Boards.'),
        ('Keep contact details current', "Please tell the school office if a pupil's emergency contact number changes."),
        ('Physical activity guidance', 'The nurse and PE staff have shared the current arrangements for lessons and fixtures.'),
        ('First aid cover during fixtures', 'The duty rota is with the activities coordinator. Contact the nurse with questions about arrangements.'),
        ('Care plan review dates', 'The nurse will contact families directly when a care plan is due for review.'),
        ('Reception holds the first aid kit', 'Staff should follow the school procedure and contact the nurse when supplies are used.'),
        ('Wellbeing room opening times', 'The room is available at break and lunch. The nurse can confirm the rota with staff.'),
        ('Update the medicine cupboard log', 'Authorised staff should record stock checks with the nurse at the end of each term.'),
    ),
    'finance': (
        ('Autumn term statements are ready', "The bursar has issued each family's termly statement through the school office."),
        ('Payment dates for this term', 'The next instalment is due on 15 October. Contact the accounts office if you need a copy of the schedule.'),
        ('', ''),
        ('Bursary review window', 'Applications for the spring term close on 30 November. The bursar can explain the required documents.'),
        ('Receipt references', 'Please include the statement number when contacting the accounts office about a payment.'),
        ('Termly fee schedule approved', 'The current schedule is available from the bursar. It covers tuition and agreed school charges.'),
        ('Refund requests', 'Send a written request to the accounts office with the original receipt reference.'),
        ('Finance office opening hours', 'The accounts team is available in person from 9.00 am to 3.30 pm on school days.'),
    ),
    'facilities': (
        ('Auditorium closed for maintenance', 'Contractors will work in the auditorium on Saturday. Use the main hall for rehearsals.'),
        ('Water interruption on Saturday morning', 'The lower school block will have no water from 8.00 am to 11.00 am.'),
        ('Room checks before the new term', 'Caretakers are checking doors, lighting and furniture across the teaching rooms.'),
        ('Sports hall floor inspection', 'The hall is unavailable until the inspection is complete. The PE office will confirm the timetable.'),
        ('Fire door checks this week', 'Please keep corridors clear while the facilities team checks each fire door.'),
        ('Library lights replaced', 'The east reading area is open again after the lighting work.'),
        ('Report room faults to the caretaker', 'Include the room code and a short description so the team can plan the repair.'),
        ('Grounds team preparing the playing field', 'The field will reopen after the surface work is finished next week.'),
    ),
    'hr': (
        ('Professional learning dates', 'The staff development calendar includes inset sessions and subject workshops for this term.'),
        ('Cover requests for next week', 'Please file leave requests early so the head of department can plan class cover.'),
        ('New starter induction', 'The next induction covers school routines, safeguarding contacts and staff systems.'),
        ('Staff handbook updated', 'The current handbook is available from Human Resources. Please check the leave section.'),
        ('Wellbeing sessions for staff', 'Human Resources will share the booking details with staff through the internal noticeboard.'),
        ('Autumn term leave deadlines', 'Submit planned leave dates to your supervisor before the department rota is finalised.'),
        ('Payroll calendar', 'The monthly payroll dates are listed on the staff portal.'),
        ('Staff contact details', 'Tell Human Resources if your emergency contact or telephone number changes.'),
    ),
    'project:academic': (
        ('Assessment and reporting cycle', 'The academic office has published the dates for marking, form review and report release.'),
        ('Year-group progress review', 'Subject leads will confirm outstanding marks with form tutors before the review meeting.'),
        ('Term report checks begin Monday', 'Check each class section before the registrar prepares the reporting batch.'),
        ('Headteacher review window', "The academic dean will share the order for reviewing each year group's reports."),
        ('Papers returned to pupils', 'Subject staff should return marked work with clear guidance for the next unit.'),
        ('Form tutor notes are due', 'Add concise progress notes before the adviser review starts.'),
        ("Parents' evening appointments", 'Families can book with form tutors after school reports are issued.'),
        ('Cycle review', 'The academic office will gather feedback after the reporting cycle closes.'),
    ),
    'project:student_affairs': (
        ('Clubs and enrichment programme', 'The activities coordinator is checking rooms and staff cover for the next half-term.'),
        ('Club sign-ups open in form time', 'Pupils can choose an activity from the list shared by their form tutor.'),
        ('Choir rehearsal moves to Tuesday', 'The music room is reserved after lessons. The librarian has posted the new time.'),
        ('Winter concert planning', 'Staff can add set-up tasks to the programme before the next meeting.'),
        ('House reading challenge', 'Forms can record completed books with the librarian during the weekly check-in.'),
        ('Intramural fixtures published', 'The activities office has shared the dates and pitches for each year group.'),
        ('Community gardening session', 'The group meets at the greenhouse after lessons on Thursday.'),
        ('Enrichment review', 'The student affairs team will review attendance and room use at the end of term.'),
    ),
    'project:facilities': (
        ('Site safety review schedule', 'The facilities team will check teaching rooms, corridors and shared spaces this month.'),
        ('Fire and evacuation practice', 'Each form will follow the route posted beside its classroom door.'),
        ('Maintenance jobs for half-term', 'The caretaker has grouped the planned repairs by building and room code.'),
        ('Sports centre access', 'The side entrance will remain closed while the door mechanism is repaired.'),
        ('Heating checks before winter', 'The maintenance coordinator will confirm which rooms need a follow-up visit.'),
        ('Auditorium repair update', 'The contractor expects to finish the stage lighting work by Friday afternoon.'),
        ('Playing field inspection', 'The grounds team will share the reopening date after the surface check.'),
        ('Review of completed work', 'The facilities manager will check the closed requests with each site lead.'),
    ),
}  # fmt: skip

EVENT_TITLES = (
    "Parents' evenings open for booking",
    "Year-group progress review",
    "Autumn term report deadline",
    "School council meeting",
    "Half-term clubs showcase",
    "Termly fee statements issued",
    "Fire and evacuation practice",
    "New starter induction",
    "Room safety walk-through",
    "Parents' evening appointments",
    "Staff development session",
    "Academic reporting review",
)

EVENT_DETAILS = {
    "Parents' evenings open for booking": "Form tutors will confirm the appointment list with families through the school office.",
    "Year-group progress review": "Subject leads will review current work and agree follow-up dates with form tutors.",
    "Autumn term report deadline": "The academic office needs approved entries before the registrar prepares each batch.",
    "School council meeting": "Representatives will review ideas for the next half-term and record agreed actions.",
    "Half-term clubs showcase": "Activity leads will meet families in the main hall after the final lesson.",
    "Termly fee statements issued": "The accounts team will issue termly statements and confirm the payment dates.",
    "Fire and evacuation practice": "Staff will guide each form to the assembly point and check the room list.",
    "New starter induction": "The admissions and academic teams will explain school routines and first-week arrangements.",
    "Room safety walk-through": "The caretaker and facilities manager will review access, lighting and room condition.",
    "Parents' evening appointments": "Families can meet form tutors after school reports are issued.",
    "Staff development session": "Department leads will review the term's professional learning plan.",
    "Academic reporting review": "The registrar will review the reporting cycle with year-group leads.",
}

EVENT_LOCATIONS = (
    "Wrenfield School main hall",
    "Academic office meeting room",
    "Lower school reception",
    "Sports centre classroom",
)

BOARD_DESCRIPTIONS = {
    "Parents' Evening Planning": "Appointment planning and room arrangements for family meetings.",
    "Clubs and Enrichment Programme": "Staff cover, rooms and dates for the school's enrichment activities.",
    "Site Safety Review": "A shared schedule for room checks and planned maintenance work.",
}

LAYOUT_NAMES = {
    "table": "{module}: all records",
    "grid": "{module} at a glance",
    "gallery": "{module} cards",
    "kanban": "{module} by status",
    "calendar": "{module} calendar",
    "timeline": "{module} schedule",
}

_MODULE_NAMES = {module.key: module.name for module in _MODULES}


def _board_kind(board: Mapping[str, Any]) -> str:
    department = board.get("department_key")
    if department is None:
        return "company"
    return f"project:{department}" if board.get("scope") == "project" else str(department)


def _module_label(module_key: str) -> str:
    if module_key not in _MODULE_NAMES:
        raise ValueError("Unknown School module")
    return _MODULE_NAMES[module_key]


def post_text(
    board: Mapping[str, Any], index: int, assessment_total: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Return an announcement, including the named part-payment statement."""
    if _board_kind(board) == "finance" and index == 2:
        balance = assessment_total - paid
        return (
            "Termly statement: payment received",
            f"The termly fee assessment is £{assessment_total:,.2f}. A linked payment of "
            f"£{paid:,.2f} leaves £{balance:,.2f} due. Please review the statement and "
            "receipt together.",
        )
    title, body = POSTS[_board_kind(board)][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """Record a short update after a school announcement is published."""
    return f"{title} (updated)"[:100], f"{body} Updated: details confirmed with the school office."[
        :2000
    ]


def project_board(name: str) -> tuple[str, str]:
    return name, BOARD_DESCRIPTIONS[name]


def view_name(module_key: str, layout: str) -> str:
    return LAYOUT_NAMES[layout].format(module=_module_label(module_key))


def dashboard_name(department_name: str) -> str:
    return f"{department_name} overview"


def report_names(module_key: str, cadence: str, group_name: str | None) -> tuple[str, str]:
    title = f"{cadence.title()} {_module_label(module_key).lower()} summary"
    subtitle = f"Grouped by {group_name.lower()}" if group_name else "All records with row count"
    return title, subtitle
