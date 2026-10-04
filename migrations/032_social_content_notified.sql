-- Los avisos de «sin preparar» por hueco se sustituyen por un resumen diario:
-- los borradores que ya recibieron ese aviso vuelven a poder avisar de
-- «Toca publicar» cuando estén listos.
UPDATE social_content_calendar SET notified_at = NULL WHERE status IN ('draft', 'generating');
