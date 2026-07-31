Use the octto tools to ask me one question. Call start_session with a single pick_one
question titled "Which datastore should we use?" offering exactly two options: redis and
postgres. Then call get_next_answer with block=true to wait for my reply. As soon as you
have my answer, respond with the line E2E_LIVE_OK followed by the option I chose.
