import hashlib
import json
import re
import pytz
from pytz.tzinfo import BaseTzInfo
from enum import Enum
from datetime import datetime, timedelta, timezone
from dateutil import parser as dup
from timezonefinder import TimezoneFinder

from utils.logger import get_logger

logger = get_logger(__name__)


# =========================
# Generators & helpers
# =========================
def filter_serializable(obj):
    """
    Zorgt dat alleen JSON-serializable typen overblijven.
    Recursief voor dicts en lists.
    """
    if isinstance(obj, dict):
        return {
                k:filter_serializable(v)
                for k, v in obj.items()
                if is_serializable(v)
                }
    elif isinstance(obj, list):
        return [filter_serializable(v) for v in obj if is_serializable(v)]
    else:
        return obj


def is_serializable(value):
    """
    Check of iets JSON-serializable is.
    """
    try:
        json.dumps(value)
        return True
    except (TypeError, ValueError):
        return False


def genereer_hash(msg):
    """Genereert een stabiele SHA-256 hash voor serialiseerbare berichtdata.
    
    Args:
        msg: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    try:
        if isinstance(msg, bytes):
            data = msg

        elif isinstance(msg, str):
            data = msg.encode("utf-8")

        elif isinstance(msg, (dict, list)):
            # 🔥 Opschonen eerst:
            cleaned = filter_serializable(msg)
            data = json.dumps(cleaned, sort_keys=True).encode("utf-8")

        else:
            data = str(msg).encode("utf-8")

        return hashlib.sha256(data).hexdigest()

    except Exception as e:
        logger.error("Hash-generatie mislukt: %s voor %r", e, msg)
        return None


def flatten_multilevel(data, prefix=""):
    """Vlakt geneste dictionaries en lijsten af naar puntnotatie.
    
    Args:
        data: Invoerwaarde voor deze functie.
        prefix: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    flat_items = []
    if isinstance(data, dict):
        for k, v in data.items():
            full_key = f"{prefix}.{k}" if prefix else k
            flat_items.extend(flatten_multilevel(v, prefix=full_key))
    elif isinstance(data, list):
        for i, item in enumerate(data):
            full_key = f"{prefix}[{i}]"
            flat_items.extend(flatten_multilevel(item, prefix=full_key))
    else:
        flat_items.append((prefix, data))

    if prefix == "":
        if isinstance(data, dict):
            return dict(flat_items)
        elif isinstance(data, list):
            return list(flat_items)
    return flat_items


def remap_keys(data, mapping):
    """Zet keys uit geneste data om volgens een mappingtabel.
    
    Args:
        data: Invoerwaarde voor deze functie.
        mapping: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    result = {}
    unmapped_keys = []

    logger.debug("remap_keys input: %s", data)

    flat_data = flatten_multilevel(data, prefix="")

    if not flat_data:
        return result, unmapped_keys

    if isinstance(flat_data, dict):
        items = flat_data.items()
    elif isinstance(flat_data, list):
        items = flat_data
    else:
        logger.warning("Unexpected flattened data type: %s", type(flat_data).__name__)
        return result, unmapped_keys

    for key, value in items:
        if key in mapping:
            new_key = mapping[key]
            if new_key is not None and value is not None:
                result[new_key] = value
        else:
            unmapped_keys.append(key)

    if not result:
        logger.debug("Geen overeenkomende keys gevonden in bericht.")
        for key, value in mapping.items():
            if value is not None:
                return {}, unmapped_keys
        return {}, unmapped_keys

    return result, unmapped_keys


# =========================
# Converters
# =========================
def convert_enum_values(obj):
    """Converteer Enum-objecten naar hun waarde en naam."""
    if isinstance(obj, Enum):
        return obj.value, obj.name if obj.value is not None else None
    return obj, None

def convert_speed(value, from_unit):
    """
    Converts any speed value to a dict with keys: 'm/s', 'km/h', 'kt', 'bft'.
    Return m/s
    """
    units_to_mps = {
            'm/s' :1,
            'km/h':1 / 3.6,
            'mph' :0.44704,
            'kt'  :0.514444,
            'ft/s':0.3048,
            'bft' :None,  # special handling
            }

    def mps_to_beaufort(mps):
        """Voert de verwerkingslogica uit voor `mps_to_beaufort`.
        
        Args:
            mps: Invoerwaarde voor deze verwerking.
        """
        bft_table = [
                (0.0, 0.2), (0.3, 1.5), (1.6, 3.3), (3.4, 5.4),
                (5.5, 7.9), (8.0, 10.7), (10.8, 13.8), (13.9, 17.1),
                (17.2, 20.7), (20.8, 24.4), (24.5, 28.4), (28.5, 32.6),
                (32.7, float('inf'))
                ]
        for bft, (min_val, max_val) in enumerate(bft_table):
            if min_val <= mps <= max_val:
                return bft
        return None

    def beaufort_to_mps(bft):
        """Voert de verwerkingslogica uit voor `beaufort_to_mps`.
        
        Args:
            bft: Invoerwaarde voor deze verwerking.
        """
        bft_midpoints = [
                0.1, 0.9, 2.45, 4.4, 6.7, 9.35, 12.3, 15.5, 19.0,
                22.6, 26.45, 30.55, 35.0
                ]
        if 0 <= bft < len(bft_midpoints):
            return bft_midpoints[bft]
        else:
            raise ValueError("Beaufort value must be between 0 and 12")

    try:
        # Convert input to m/s first
        from_unit = from_unit.lower()
        if from_unit == 'bft':
            value_in_mps = beaufort_to_mps(int(value))
        elif from_unit in units_to_mps:
            value_in_mps = value * units_to_mps[from_unit]
        else:
            raise ValueError(f"Invalid input unit: {from_unit}")

        # Create output dict
        output = {
                'm/s' :round(value_in_mps, 1),
                'km/h':round(value_in_mps * 3.6, 1),
                'kt'  :round(value_in_mps / 0.514444, 1),
                'bft' :mps_to_beaufort(value_in_mps)
                }
        return output
    except Exception as e:
        logger.error(f"Conversion error: {e} | value={value}, from_unit={from_unit}")
        return None


def convert_dt_to_unixtimestamp(ts):
    """Converteert een datum/tijdwaarde naar een Unix timestamp in milliseconden.
    
    Args:
        ts: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    try:
        if not ts:
            return None

        if isinstance(ts, datetime):
            return int(ts.timestamp() * 1000)

        elif isinstance(ts, (int, float)):
            return int(ts * 1000) if ts < 1e11 else int(ts)

        elif isinstance(ts, str) and ts.isdigit():
            ts_int = int(ts)
            return ts_int * 1000 if ts_int < 1e11 else ts_int

        else:
            dt = dup.parse(ts)
            return int(dt.timestamp() * 1000)

    except Exception as e:
        logger.error("Datum/Tijd conversie naar unixtime mislukt voor %r: %s", ts, e)
        return None



def convert_unixtimestamp_to_dt(ts, tz=None, lat=None, lon=None):
    # return: dt_label,  d_label, t_label, dtobj = (YYYY-MM-DD HH:MM:SS, YYYY-MM-DD,  HH:MM:SS, DateTime object)
    """Converteert een Unix timestamp naar een datetime-object.
    
    Args:
        ts: Invoerwaarde voor deze functie.
        tz: Invoerwaarde voor deze functie.
        lat: Invoerwaarde voor deze functie.
        lon: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    if not ts:
        return ["-", "-","-",None]
    elif isinstance(tz, BaseTzInfo):
        tzobj = tz
    elif lat  and lon:
        tf = TimezoneFinder()
        tz = tf.timezone_at(lat=lat, lng=lon)
        tzobj = pytz.timezone(tz)
    else:
        if not tz:
            tz = "Europe/Amsterdam"
        tzobj = pytz.timezone(tz)


    dt = datetime.fromtimestamp(ts / 1000, tzobj)
    return (dt.isoformat(sep=' ', timespec='seconds'),
            dt.strftime("%Y-%m-%d"),
            dt.strftime("%H:%M:%S"),
            dt
            )

def convert_str_to_polygon(s: str):
    """Converteert een tekstuele geometriewaarde naar een polygonrepresentatie.
    
    Args:
        s: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    from django.contrib.gis.geos import Polygon, LinearRing, MultiPolygon
    """
    Converteert één polygon-string uit de API naar GEOS Polygon.
    API formaat: 'lat,lon lat,lon ...' -> GEOS verwacht (lon, lat).
    Sluit ring automatisch.
    """
    if not s or not s.strip():
        raise ValueError("Lege polygon-string")

    pts = []
    for pair in s.replace("\n", " ").split():
        lat_str, lon_str = pair.split(",")
        lat = float(lat_str)
        lon = float(lon_str)
        pts.append((lon, lat))  # (x=lon, y=lat)

    if pts[0] != pts[-1]:
        logger.debug("Ring niet gesloten; sluit automatisch (eerste=%s, laatste=%s)", pts[0], pts[-1])
        pts.append(pts[0])

    ring = LinearRing(pts)
    poly = Polygon(ring)
    logger.debug("Polygon geconstrueerd met %d punten", len(pts))
    return poly

def convert_list_to_multipolygon(raw):
    """Converteert een lijst met polygonen naar een multipolygonrepresentatie.
    
    Args:
        raw: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    from django.contrib.gis.geos import Polygon, LinearRing, MultiPolygon
    """
    Bouwt een MultiPolygon uit een 'area' veld zoals in de NL-Alert API (list van polygon-strings).
    """
    if not raw:
        logger.debug("Geen area-raw aanwezig; return None")
        return None

    polygons = []
    for item in raw:
        try:
            if isinstance(item, str):
                polygons.append(convert_str_to_polygon(item))
            elif isinstance(item, list):
                for s in item:
                    polygons.append(convert_str_to_polygon(s))
            else:
                logger.warning("Onbekend area-itemtype: %r (skip)", type(item))
        except Exception:
            logger.exception("Fout bij converteren van polygon: %r", item)

    if not polygons:
        logger.debug("Geen geldige polygonen gevonden; return None")
        return None

    mp = MultiPolygon(polygons)
    logger.debug("MultiPolygon aangemaakt met %d polygon(en)", len(polygons))
    return mp


# =========================
# Formatters (optioneel)
# =========================
ALWAYS_UPPER_CASE = [
        "KNRM", "RB", "RN", "RWS",
        "SECURITE", "WARNING", "DANGER", "WATCH OUT!",
        "VHF", "CH", "DSC", "GMDSS", "NAVTEX", "SATCOM", "SRM",
        "VTS", "TSS", "WAYPOINT",
        "CPA", "TCPA", "LAT", "LON", "ETA", "ETD", "NM",
        "SAR", "EPIRB", "SART", "PLB", "MOB", "MAYDAY", "PAN", "PANPAN",
        "CH",
        ]

def smart_title_case(text, exceptions=None, force_upper=None):
    """Formatteert tekst naar titelnotatie met behoud van bekende uitzonderingen.
    
    Args:
        text: Invoerwaarde voor deze functie.
        exceptions: Invoerwaarde voor deze functie.
        force_upper: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    if not isinstance(text, str):
        return None

    text = text.strip()
    if not text:
        return ""

    if exceptions is None:
        exceptions = {
            # NL
            "de", "het", "een", "en", "van", "in", "op", "bij", "te", "voor",
            "met", "onder", "zonder", "aan", "tot", "als", "door", "over",
            "na", "tussen", "tegen", "om", "boven", "achter", "rond",
            # EN
            "the", "a", "an", "and", "or", "but", "nor", "so", "yet",
            "at", "by", "for", "in", "of", "on", "to", "with", "up", "as",
            "over", "into", "from", "about", "after", "before", "under",
            "between", "around", "during",
        }

    if force_upper is None:
        force_upper = ALWAYS_UPPER_CASE

    force_upper_lower = {w.lower() for w in force_upper}

    def format_piece(piece, is_first_word=False):
        """Voert de verwerkingslogica uit voor `format_piece`.
        
        Args:
            piece: Invoerwaarde voor deze verwerking.
            is_first_word: Invoerwaarde voor deze verwerking.
        """
        if not piece:
            return piece

        # Leestekens aan begin/einde bewaren
        m = re.match(r"^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$", piece)
        if not m:
            return piece

        prefix_punct, core, suffix_punct = m.groups()

        if not core:
            return piece

        core_lower = core.lower()

        # Exacte uppercase match
        if core_lower in force_upper_lower:
            formatted = core.upper()

        # Apostrof-namen zoals d'artagnan of o'neill
        elif "'" in core:
            subparts = core_lower.split("'")
            formatted_parts = []
            for idx, sub in enumerate(subparts):
                if not sub:
                    formatted_parts.append(sub)
                elif idx == 0 and sub in exceptions and not is_first_word:
                    formatted_parts.append(sub)
                else:
                    formatted_parts.append(sub.capitalize())
            formatted = "'".join(formatted_parts)

        # Gewone woorden
        else:
            if is_first_word or core_lower not in exceptions:
                formatted = core_lower.capitalize()
            else:
                formatted = core_lower

        return f"{prefix_punct}{formatted}{suffix_punct}"

    def format_token(token, is_first_word=False):
        # Splits op - en / maar behoudt die separators
        """Voert de verwerkingslogica uit voor `format_token`.
        
        Args:
            token: Invoerwaarde voor deze verwerking.
            is_first_word: Invoerwaarde voor deze verwerking.
        """
        parts = re.split(r"([-/])", token)
        out = []
        first_subword = is_first_word

        for part in parts:
            if part in {"-", "/"}:
                out.append(part)
            else:
                out.append(format_piece(part, is_first_word=first_subword))
                if part.strip():
                    first_subword = False

        return "".join(out)

    tokens = text.split()
    result = []

    for i, token in enumerate(tokens):
        result.append(format_token(token, is_first_word=(i == 0)))

    return " ".join(result)


def smart_text_case(text):
    """Formatteert vrije tekst naar consistente hoofdlettergebruik.
    
    Args:
        text: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    if not isinstance(text, str):
        return None

    text = text.strip().lower()
    if not text:
        return ""

    abbreviations = [
        "e.g.", "i.e.", "etc.", "u.s.a.", "u.k.", "mr.", "mrs.", "ms.", "dr.", "prof.", "ph.d.",
        "a.m.", "p.m.", "d.w.z.", "m.a.w.", "o.a.", "t.a.v.", "t.o.v.", "z.o.z.", "bv.",
        "m.b.t.", "m.i.v.", "nl.", "ca.", "nr.", "blz.", "ref.", "i.v.m.", "v.b.", "o.i.d.",
        "no.", "vol.", "fig.",
    ]

    always_upper = ALWAYS_UPPER_CASE
    always_upper_lower = {w.lower(): w for w in always_upper}

    # 1. Bescherm afkortingen tijdelijk tegen zins-splitting
    placeholder_map = {}
    for i, abbr in enumerate(abbreviations):
        placeholder = f"__abbr{i}__"
        placeholder_map[placeholder] = abbr
        text = text.replace(abbr.lower(), placeholder)


    parts = re.split(r'([.!?]["\')\]]*\s+)', text)

    sentences = []
    for i in range(0, len(parts), 2):
        sentence = parts[i].strip()
        punctuation = parts[i + 1] if i + 1 < len(parts) else ""

        if sentence:
            sentence = sentence[0].upper() + sentence[1:]
            if punctuation:
                sentences.append(sentence + punctuation.strip())
            else:
                sentences.append(sentence)

    result = " ".join(sentences)


    for placeholder, abbr in placeholder_map.items():
        result = result.replace(placeholder, abbr)


    def apply_upper_to_token(token):
        """Voert de verwerkingslogica uit voor `apply_upper_to_token`.
        
        Args:
            token: Invoerwaarde voor deze verwerking.
        """
        parts = re.split(r'([-/])', token)
        out = []
        for part in parts:
            lower_part = part.lower()
            if lower_part in always_upper_lower:
                out.append(always_upper_lower[lower_part])
            else:
                out.append(part)
        return "".join(out)

    # Pas toe op "woordachtige" tokens inclusief - en /
    result = re.sub(
        r'\b[\w/-]+\b',
        lambda m: apply_upper_to_token(m.group(0)),
        result,
        flags=re.IGNORECASE
    )

    return result


def format_ms_to_age(age_ms):
    """Formatteert een tijdsverschil in milliseconden naar een leesbare leeftijd.
    
    Args:
        age_ms: Invoerwaarde voor deze functie.
    
    Returns:
        Het resultaat van de bewerking, indien van toepassing.
    """
    if age_ms is None:
        return "-"

    age_ms = int(age_ms)
    total_seconds = abs(age_ms) // 1000
    days, remainder = divmod(total_seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, seconds = divmod(remainder, 60)

    prefix = "Toekomst: " if age_ms < 0 else ""

    if days:
        return prefix + f"{days}d {hours:02d}h {minutes:02d}m {seconds:02d}s"
    elif hours:
        return prefix + f"{hours}h {minutes:02d}m {seconds:02d}s"
    elif minutes:
        return prefix + f"{minutes}m {seconds:02d}s"
    else:
        return prefix + f"{seconds}s"
