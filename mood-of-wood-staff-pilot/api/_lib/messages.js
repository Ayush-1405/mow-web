// Mood of Wood — Node API — bilingual (EN/GU) user-safe error/status
// messages. Ported verbatim from supabase/functions/_shared/messages.ts so
// every migrated endpoint returns byte-identical error text to what the
// Edge Function/RPC it replaces returned. None of these strings ever
// include internal details (SQL error text, stack traces, internal email,
// etc.) — those are only ever written to server-side logs (console.error),
// never returned to the client. Add new keys here as later phases need
// them; do not invent ad-hoc inline error strings in individual endpoints.

export const MSG = {
  invalidJson: {
    en: "The request could not be understood. Please try again.",
    gu: "વિનંતી સમજી શકાઈ નથી. કૃપા કરીને ફરી પ્રયાસ કરો.",
  },
  missingFields: {
    en: "Required information is missing. Please check and try again.",
    gu: "જરૂરી માહિતી ખૂટે છે. કૃપા કરીને તપાસો અને ફરી પ્રયાસ કરો.",
  },
  methodNotAllowed: {
    en: "This action is not supported.",
    gu: "આ ક્રિયા સમર્થિત નથી.",
  },
  unauthorized: {
    en: "You are not signed in, or your session has expired.",
    gu: "તમે સાઇન ઇન નથી, અથવા તમારું સત્ર સમાપ્ત થયું છે.",
  },
  notAuthorized: {
    en: "You are not authorized to perform this action.",
    gu: "તમને આ ક્રિયા કરવાની અધિકૃતતા નથી.",
  },
  accountInactive: {
    en: "Your account is not active. Contact your administrator.",
    gu: "તમારું ખાતું સક્રિય નથી. તમારા સંચાલકનો સંપર્ક કરો.",
  },
  mustChangePassword: {
    en: "You must change your password before continuing.",
    gu: "ચાલુ રાખતા પહેલા તમારે તમારો પાસવર્ડ બદલવો પડશે.",
  },
  invalidLogin: {
    en: "Invalid employee code or password",
    gu: "કર્મચારી કોડ અથવા પાસવર્ડ ખોટો છે",
  },
  tooManyAttempts: {
    en: "Too many failed attempts. Please try again after some time.",
    gu: "ઘણા બધા નિષ્ફળ પ્રયત્નો. કૃપા કરીને થોડા સમય પછી ફરી પ્રયાસ કરો.",
  },
  weakPassword: {
    en: "Password must be at least 8 characters and include an uppercase letter, a lowercase letter and a number.",
    gu: "પાસવર્ડ ઓછામાં ઓછો 8 અક્ષરોનો હોવો જોઈએ અને તેમાં મોટો અક્ષર, નાનો અક્ષર અને અંક હોવો જોઈએ.",
  },
  serverError: {
    en: "Something went wrong. Please try again later.",
    gu: "કંઈક ખોટું થયું. કૃપા કરીને પછીથી ફરી પ્રયાસ કરો.",
  },
  duplicateEmployeeCode: {
    en: "This employee code is already in use.",
    gu: "આ કર્મચારી કોડ પહેલેથી ઉપયોગમાં છે.",
  },
  invalidRole: {
    en: "The selected role is not valid.",
    gu: "પસંદ કરેલી ભૂમિકા માન્ય નથી.",
  },
  sysadminDisabled: {
    en: "System Administrator accounts cannot be created in this pilot.",
    gu: "આ પાયલોટમાં સિસ્ટમ એડમિનિસ્ટ્રેટર ખાતાં બનાવી શકાતાં નથી.",
  },
  managementDisabled: {
    en: "Only one Management account is permitted in this pilot.",
    gu: "આ પાયલોટમાં ફક્ત એક જ મેનેજમેન્ટ ખાતાની મંજૂરી છે.",
  },
  invalidEmployeeCodeFormat: {
    en: "Employee code must look like MOW-XXXX (letters, numbers and hyphens only).",
    gu: "કર્મચારી કોડ MOW-XXXX જેવો હોવો જોઈએ (ફક્ત અક્ષરો, અંકો અને હાઇફન).",
  },
  accountsRoleRequiresAccountsDept: {
    en: "This role can only be created inside the Accounts department.",
    gu: "આ ભૂમિકા ફક્ત એકાઉન્ટ્સ વિભાગમાં જ બનાવી શકાય છે.",
  },
  genericRoleBlockedInAccounts: {
    en: "Only Accounts-specific roles can be created inside the Accounts department during this pilot phase.",
    gu: "આ પાયલોટ તબક્કા દરમિયાન એકાઉન્ટ્સ વિભાગમાં ફક્ત એકાઉન્ટ્સ-વિશિષ્ટ ભૂમિકાઓ જ બનાવી શકાય છે.",
  },
  invalidDepartment: {
    en: "The selected department is not valid.",
    gu: "પસંદ કરેલો વિભાગ માન્ય નથી.",
  },
  invalidLocation: {
    en: "The selected location is not valid.",
    gu: "પસંદ કરેલું સ્થાન માન્ય નથી.",
  },
  roleNotPermitted: {
    en: "You are not authorized to create a user with this role.",
    gu: "તમને આ ભૂમિકા સાથે વપરાશકર્તા બનાવવાની અધિકૃતતા નથી.",
  },
  approvalNotAvailable: {
    en: "This role requires an approval workflow that is not available in this pilot.",
    gu: "આ ભૂમિકા માટે મંજૂરી પ્રક્રિયા જરૂરી છે જે આ પાયલોટમાં ઉપલબ્ધ નથી.",
  },
  outsideScope: {
    en: "The selected department is outside your authorized scope.",
    gu: "પસંદ કરેલો વિભાગ તમારા અધિકૃત ક્ષેત્રની બહાર છે.",
  },
  confidentialRestricted: {
    en: "You are not authorized to create users in this department.",
    gu: "તમને આ વિભાગમાં વપરાશકર્તા બનાવવાની અધિકૃતતા નથી.",
  },
  fileTooLarge: {
    en: "File exceeds the 20 MB limit for this pilot.",
    gu: "ફાઇલ આ પાયલોટ માટે 20 MB ની મર્યાદા કરતાં વધી જાય છે.",
  },
  fileTypeNotAllowed: {
    en: "This file type is not allowed.",
    gu: "આ ફાઇલ પ્રકારની મંજૂરી નથી.",
  },
  voiceDurationInvalid: {
    en: "Voice messages must be between 1 and 60 seconds.",
    gu: "વોઇસ સંદેશ 1 થી 60 સેકન્ડની વચ્ચે હોવો જોઈએ.",
  },
  noAccessToParent: {
    en: "You do not have access to this task or bridge.",
    gu: "તમને આ કાર્ય અથવા બ્રિજ પર પ્રવેશ નથી.",
  },
  attachmentNotFound: {
    en: "The requested file could not be found or you do not have access to it.",
    gu: "વિનંતી કરેલી ફાઇલ મળી નથી અથવા તમને તેની પર પ્રવેશ નથી.",
  },
  invalidAction: {
    en: "The requested action is not recognized.",
    gu: "વિનંતી કરેલી ક્રિયા ઓળખાતી નથી.",
  },
  taskNotFound: {
    en: "The requested task could not be found.",
    gu: "વિનંતી કરેલું કાર્ય મળ્યું નથી.",
  },
  invalidTransition: {
    en: "This action cannot be performed on the task in its current status.",
    gu: "કાર્યની હાલની સ્થિતિમાં આ ક્રિયા કરી શકાતી નથી.",
  },
  reasonRequired: {
    en: "A reason is required.",
    gu: "કારણ જરૂરી છે.",
  },
};
