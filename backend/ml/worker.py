"""Persistent bounded JSONL worker; stdout reserved for its request protocol."""
import json
import sys

from .features import MAX_BYTES, ValidationError
from .inference import analyze_csv


def main():
    for line in sys.stdin:
        request_id = None
        try:
            if len(line.encode("utf-8")) > MAX_BYTES * 2:
                raise ValidationError("Request exceeds the allowed size.")
            request = json.loads(line)
            request_id = request.get("id")
            result = analyze_csv(request.get("csv"))
            response = dict(id=request_id, result=result)
        except ValidationError as exc:
            response = dict(id=request_id, error=dict(message=str(exc), quality=exc.quality))
        except (ValueError, TypeError, KeyError):
            response = dict(id=request_id, error=dict(message="The analysis request or installed model artifact is invalid."))
        except Exception:
            response = dict(id=request_id, error=dict(message="Analysis is temporarily unavailable."))
        print(json.dumps(response, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
