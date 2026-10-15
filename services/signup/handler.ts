// Cognito trigger for student self-registration (training demo: lightest possible restrictions).
//   PreSignUp_SignUp:               auto-confirm (no email, no verification code); reject an unknown role.
//   PostConfirmation_ConfirmSignUp: add the user to the group for the role chosen on the Create account form.
// The role travels as SignUp ClientMetadata, which Cognito passes to both triggers. Sign-ups through the managed login
// page carry no role and default to analyst.
import { AdminAddUserToGroupCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

const idp = new CognitoIdentityProviderClient({});
const GROUPS: Record<string, string> = {
  analyst: process.env.ANALYST_GROUP ?? 'claims-analysts',
  supervisor: process.env.SUPERVISOR_GROUP ?? 'claims-supervisors',
};

interface TriggerEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: { clientMetadata?: Record<string, string> };
  response: { autoConfirmUser?: boolean };
}

export async function handler(event: TriggerEvent): Promise<TriggerEvent> {
  const role = event.request.clientMetadata?.role ?? 'analyst';
  if (event.triggerSource === 'PreSignUp_SignUp') {
    if (!(role in GROUPS)) throw new Error(`Unknown user type "${role}". Choose analyst or supervisor.`);
    event.response.autoConfirmUser = true;
  } else if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const group = GROUPS[role] ?? GROUPS.analyst;
    await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName: group }));
    console.log(JSON.stringify({ type: 'self_signup', username: event.userName, role, group }));
  }
  return event;
}
