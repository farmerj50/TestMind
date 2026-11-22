// Browser audit identity adapter only. The production useApi implementation runs.
const getToken = async () => 'fixture-owner';
export const useAuth = () => ({ getToken });
