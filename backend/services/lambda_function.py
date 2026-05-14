import json
import boto3
import re
from decimal import Decimal
from datetime import datetime
from collections import defaultdict
from urllib.parse import unquote_plus

s3 = boto3.client("s3")
textract = boto3.client("textract")
dynamodb = boto3.resource("dynamodb")

# DynamoDB table name
TABLE_NAME = "ReceiptHealthAnalysis"

table = dynamodb.Table(TABLE_NAME)

# -----------------------------
# FOOD CLASSIFICATION LISTS
# -----------------------------

HEALTHY_ITEMS = {
    "apple", "apples", "banana", "bananas", "avocado", "avocados",
    "grapes", "carrot", "carrots", "spinach", "broccoli", "tomato",
    "tomatoes", "lettuce", "kale", "orange", "oranges", "berries",
    "blueberries", "strawberries", "cucumber", "peppers", "onion",
    "onions", "garlic", "sweet potato", "oats", "rice", "brown rice",
    "salmon", "chicken breast", "eggs", "milk", "greek yogurt",
    "nuts", "almonds", "walnuts", "beans", "lentils"
}

UNHEALTHY_ITEMS = {
    "crisps", "chips", "sweets", "cake", "cakes", "biscuits",
    "cookies", "chocolate", "choc", "marzipan",
    "ice cream", "processed food",
    "instant noodles", "soft drink", "cola", "soda", "oil",
    "fried chicken", "pizza", "burger", "sausages", "bacon",
    "candy", "donuts", "pastries", "energy drink"
}

NON_FOOD_KEYWORDS = {
    "shampoo", "soap", "toothpaste", "toilet paper", "detergent",
    "clothes", "shirt", "jeans", "conditioner", "deodorant",
    "toiletries", "razor", "towel", "napkins", "bleach",
    "cleaner", "dish soap", "body wash",
    "baking soda"
}

# Lines containing any of these words are receipt chrome (totals, promos,
# store info), not products — drop them before classification.
RECEIPT_NOISE_KEYWORDS = {
    "total", "subtotal", "balance", "tender", "change due", "cash", "card",
    "visa", "mastercard", "debit", "credit", "auth", "approved",
    "voucher", "vouchers", "ouchers",
    "lidlplus", "lidl plus", "clubcard", "nectar", "loyalty",
    "tid", "mid", "aid", "rrn", "merchant",
    "customer copy", "retain receipt", "please retain", "thank you",
    "tel", "fax", "vat", "vat no", "vat reg", "company reg",
    "price cut", "save ", "discount", "offer",
    "2 for", "3 for", "buy ", "with lidlplus", "x £", "x £",
}


# -----------------------------
# HELPER FUNCTIONS
# -----------------------------

def normalize_text(text):
    return re.sub(r'[^a-zA-Z0-9\s]', '', text.lower()).strip()


def matches_keyword(text, keyword):
    # Whole-word match so 'rice' doesn't trip on 'price'.
    return re.search(r'\b' + re.escape(keyword) + r'\b', text) is not None


def is_item_line(text):
    # Filter receipt chrome (prices, totals, promo banners) so unknown_items
    # only contains lines that plausibly name a product.
    stripped = text.strip()
    if len(stripped) < 3:
        return False
    # Needs at least one real word (3+ letters in a row); rejects "2 X £2.15", "1.06".
    if not re.search(r'[A-Za-z]{3,}', stripped):
        return False
    lower = stripped.lower()
    for noise in RECEIPT_NOISE_KEYWORDS:
        if noise in lower:
            return False
    return True


def extract_receipt_lines(bucket, key):
    """
    Uses Textract to extract text lines from receipt.
    """

    response = textract.detect_document_text(
        Document={
            'S3Object': {
                'Bucket': bucket,
                'Name': key
            }
        }
    )

    lines = []

    for block in response['Blocks']:
        if block['BlockType'] == 'LINE':
            lines.append(block['Text'])

    return lines


def classify_items(lines):
    """
    Classifies receipt lines into healthy, unhealthy, and non-food.
    """

    healthy = []
    unhealthy = []
    non_food = []
    unknown = []

    for line in lines:
        # Drop prices, totals, promo banners — keeps unknown_items clean.
        if not is_item_line(line):
            continue

        item = normalize_text(line)

        matched = False

        # Order matters: non-food first ('baking soda' before 'soda'),
        # then unhealthy ('choc' beats 'milk' on "Milk Choc Rabbit"),
        # then healthy as the residual.
        for non_food_item in NON_FOOD_KEYWORDS:
            if matches_keyword(item, non_food_item):
                non_food.append(line)
                matched = True
                break

        if matched:
            continue

        for unhealthy_item in UNHEALTHY_ITEMS:
            if matches_keyword(item, unhealthy_item):
                unhealthy.append(line)
                matched = True
                break

        if matched:
            continue

        for healthy_item in HEALTHY_ITEMS:
            if matches_keyword(item, healthy_item):
                healthy.append(line)
                matched = True
                break

        if not matched:
            unknown.append(line)

    return healthy, unhealthy, non_food, unknown


def calculate_health_score(healthy_count, unhealthy_count):
    total_food = healthy_count + unhealthy_count

    if total_food == 0:
        return 0

    score = round((healthy_count / total_food) * 100)

    return score


def generate_analysis(score):
    if score >= 80:
        return "Excellent shopping habits. Your basket is heavily focused on nutritious foods."
    elif score >= 60:
        return "Good balance overall, but there is room to reduce processed foods."
    elif score >= 40:
        return "Moderately healthy shopping. Consider increasing fresh produce and reducing unhealthy snacks."
    else:
        return "Your shopping basket contains a high proportion of unhealthy or processed foods."


def generate_swaps(unhealthy_items):
    swaps = []
    seen_keywords = set()

    swap_map = {
        "crisps": "Try air-popped popcorn or roasted nuts instead.",
        "chips": "Replace chips with baked sweet potato wedges.",
        "cake": "Swap cake for Greek yogurt with berries.",
        "biscuits": "Try oatcakes or nuts instead of biscuits.",
        "soft drink": "Replace sugary drinks with sparkling water.",
        "chocolate": "Try dark chocolate with lower sugar content.",
        "pizza": "Try homemade wholemeal pizza with vegetables.",
        "ice cream": "Swap ice cream for frozen yogurt or fruit.",
        "sweets": "Reach for fresh fruit or a small handful of nuts.",
        "candy": "Reach for fresh fruit or a small handful of nuts.",
        "sausages": "Try grilled chicken breast or lean turkey mince.",
        "bacon": "Swap bacon for smoked salmon or turkey rashers.",
        "soda": "Replace soda with sparkling water and a squeeze of lime.",
        "cola": "Replace cola with kombucha or unsweetened iced tea.",
        "energy drink": "Swap energy drinks for green tea or black coffee.",
        "donuts": "Try a wholegrain muffin or oat-based pastry.",
        "pastries": "Try a wholegrain muffin or oat-based pastry.",
        "instant noodles": "Try wholegrain noodles with fresh vegetables.",
        "fried chicken": "Try baked or air-fried chicken with herbs.",
        "burger": "Try a turkey or bean burger on a wholegrain bun.",
        "ice cream": "Swap ice cream for frozen yogurt or fruit."
    }

    for item in unhealthy_items:
        normalized = normalize_text(item)

        for keyword, recommendation in swap_map.items():
            if matches_keyword(normalized, keyword) and keyword not in seen_keywords:
                swaps.append({
                    "item": item,
                    "suggestion": recommendation
                })
                seen_keywords.add(keyword)
                break

    return swaps[:5]


# -----------------------------
# MAIN LAMBDA HANDLER
# -----------------------------

def lambda_handler(event, context):

    try:
        # Get S3 upload event info
        record = event['Records'][0]

        bucket = record['s3']['bucket']['name']
        # S3 event payloads URL-encode the key (spaces -> '+', etc.).
        # Decode before handing it to Textract/S3, or the object lookup will 404.
        key = unquote_plus(record['s3']['object']['key'])

        # Extract receipt text
        receipt_lines = extract_receipt_lines(bucket, key)

        # Classify items
        healthy_items, unhealthy_items, non_food_items, unknown_items = classify_items(receipt_lines)

        # Health score
        health_score = calculate_health_score(
            len(healthy_items),
            len(unhealthy_items)
        )

        # Analysis text
        analysis = generate_analysis(health_score)

        # Suggested swaps
        swaps = generate_swaps(unhealthy_items)

        # Save result
        receipt_id = key.replace("/", "_")

        item = {
            "receipt_id": receipt_id,
            "uploaded_at": datetime.utcnow().isoformat(),
            "s3_bucket": bucket,
            "s3_key": key,
            "healthy_items": healthy_items,
            "unhealthy_items": unhealthy_items,
            "non_food_items": non_food_items,
            "unknown_items": unknown_items,
            "health_score": Decimal(str(health_score)),
            "analysis": analysis,
            "food_swaps": swaps
        }

        table.put_item(Item=item)

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Receipt processed successfully",
                "receipt_id": receipt_id,
                "health_score": health_score,
                "analysis": analysis
            })
        }

    except Exception as e:
        print(f"Error processing receipt: {str(e)}")

        return {
            "statusCode": 500,
            "body": json.dumps({
                "error": str(e)
            })
        }
