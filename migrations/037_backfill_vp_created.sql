UPDATE leads SET vp_created = TRUE
WHERE vp_created = FALSE
  AND EXISTS (
    SELECT 1 FROM lead_activities
    WHERE lead_id = leads.id
      AND note LIKE 'Venue partner account created%'
  );
