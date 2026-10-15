"""Create (or reset) the demo users. Passwords are generated and stored in Secrets Manager, never in code.

    claims.analyst     -> claims-analysts      (can run analyses)
    claims.supervisor  -> claims-supervisors   (can also approve / reject)

Print passwords:  .venv/bin/python scripts/seed_users.py --show
"""
import json
import secrets
import string
import sys

import boto3

from outputs import output

USERS = {"claims.analyst": "claims-analysts", "claims.supervisor": "claims-supervisors"}
SECRET_PREFIX = "claims-workbench/demo-users/"

cognito = boto3.client("cognito-idp")
sm = boto3.client("secretsmanager")
pool = output("ClaimsWb-Foundation", "UserPoolId")


def password() -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        p = "".join(secrets.choice(alphabet) for _ in range(16))
        if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p):
            return p


def get_or_create_password(username: str) -> str:
    name = SECRET_PREFIX + username
    try:
        return json.loads(sm.get_secret_value(SecretId=name)["SecretString"])["password"]
    except sm.exceptions.ResourceNotFoundException:
        p = password()
        sm.create_secret(Name=name, Description="Claims Workbench demo user (training)",
                         SecretString=json.dumps({"username": username, "password": p}))
        return p


for username, group in USERS.items():
    pw = get_or_create_password(username)
    try:
        cognito.admin_create_user(UserPoolId=pool, Username=username, MessageAction="SUPPRESS")
    except cognito.exceptions.UsernameExistsException:
        pass
    cognito.admin_set_user_password(UserPoolId=pool, Username=username, Password=pw, Permanent=True)
    cognito.admin_add_user_to_group(UserPoolId=pool, Username=username, GroupName=group)
    print(f"  ✓ {username} ({group})" + (f"  password: {pw}" if "--show" in sys.argv else f"  password in Secrets Manager {SECRET_PREFIX}{username}"))
