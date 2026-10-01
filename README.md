# TelefonoRojo

**Lector de Super Chats**

App web local para leer con calma los Super Chats y Super Stickers de un directo de YouTube (de cualquier canal), marcarlos como leídos y verlos en orden cronológico.

## Uso

```
npm install      # solo la primera vez
npm start
```

Abre http://localhost:3000, pega el link del directo y pulsa **Escuchar**.

- Los Super Chats nuevos aparecen solos, sin recargar.
- **Desliza un mensaje hacia la derecha** para marcarlo como leído (con dedo o mouse). Deslizar uno ya leído lo desmarca. Aparece un aviso con **Deshacer** por si fue sin querer.
- **Marcar hasta aquí** marca ese y todos los anteriores.
- Abajo hay un **resumen**: sin leer / leídos, recaudado por moneda, top de donantes y el Super Chat más grande.
- Filtros: Sin leer / Todos / Leídos.
- Atajos: `J`/`K` para moverse, `Espacio` para marcar como leído y pasar al siguiente, `U` para desmarcar.
- Los directos anteriores quedan guardados en el selector, con lo que ya marcaste.

## Notas

- Solo se guardan los Super Chats que llegan **mientras la app escucha**, más los que aún estén fijados en la cinta superior del chat al conectarse. Conviene empezar al inicio del directo.
- Lee el chat igual que el navegador, sin clave de Google. Si YouTube cambia su formato, el único archivo a ajustar es `src/youtubeLive.js`.
- Los datos se guardan en `data/comentarios.db` (SQLite).
