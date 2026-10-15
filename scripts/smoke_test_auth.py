"""Get a Cognito access token for a demo user (password from Secrets Manager)."""
import json

import boto3

from outputs import output


def token(username: str) -> str:
    sm = boto3.client("secretsmanager")
    pw = json.loads(sm.get_secret_value(SecretId=f"claims-workbench/demo-users/{username}")["SecretString"])["password"]
    r = boto3.client("cognito-idp").initiate_auth(
        ClientId=output("ClaimsWb-Foundation", "UserPoolClientId"), AuthFlow="USER_AUTH",
        AuthParameters={"USERNAME": username, "PASSWORD": pw, "PREFERRED_CHALLENGE": "PASSWORD"})
    return r["AuthenticationResult"]["AccessToken"]
