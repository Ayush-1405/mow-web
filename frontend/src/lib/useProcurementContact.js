import { useEffect, useState } from "react";
import { getProcurementContact } from "./procurementApi";

// The active Procurement Head, read from their profile every time (proc_procurement_contact) -- never a stored or typed number.
export function useProcurementContact() {
  const [contact, setContact] = useState(null);
  useEffect(() => {
    let alive = true;
    getProcurementContact().then(({ data }) => { if (alive) setContact(data || { name: null, phone: null, phone_missing: true }); });
    return () => { alive = false; };
  }, []);
  return contact;
}
